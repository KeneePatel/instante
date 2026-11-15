import { request } from 'node:http';
import { z } from 'zod';
import { PROBES, probeLookup, probeTcp, type Probe, type SelftestTargets } from './probes.ts';

// The backend's client for the document service (docs/specs/platform.md, "kit"): node:http over
// DOCUMENTS_SOCKET, with a total 25-second deadline, under the web app's 30-second rewrite
// timeout. The service is treated as compromised (docs/threat-model.md): its replies are capped
// here, and every caller validates what it gets.

export const DOCUMENTS_DEADLINE_MS = 25_000;
/** A task's largest result: the service's own cap on a child's output. */
export const MAX_REPLY_BYTES = 64 * 1024 * 1024;
/** How long readiness waits for the service. */
export const READY_DEADLINE_MS = 5_000;

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export type DocumentReply = { status: number; contentType: string; body: Buffer };

export class DocumentsError extends Error {
  readonly reason: 'unavailable' | 'deadline' | 'too_large';

  constructor(reason: DocumentsError['reason'], options?: { cause?: unknown }) {
    super(`The document service ${MESSAGES[reason]}`, options);
    this.name = 'DocumentsError';
    this.reason = reason;
  }
}

const MESSAGES: Record<DocumentsError['reason'], string> = {
  unavailable: "couldn't be reached",
  deadline: 'took too long',
  too_large: 'sent too large a reply',
};

const ProbeSchema = z.custom<Probe>(
  (value) =>
    value === 'denied' ||
    value === 'allowed' ||
    (typeof value === 'string' && value.startsWith('failed: ')),
);

/** What `selftest`'s child reports (documents/tasks/selftest.ts). */
export const ChildReportSchema = z.strictObject({
  execArgv: z.array(z.string()),
  env: z.array(z.string()),
  probes: z.strictObject(
    Object.fromEntries(PROBES.map((name) => [name, ProbeSchema])) as Record<
      (typeof PROBES)[number],
      typeof ProbeSchema
    >,
  ),
});

/** The document service's `selftest` reply (documents/guards.ts). */
export const SelftestReplySchema = z.strictObject({
  ok: z.boolean(),
  /** Each check that failed, in words; empty when `ok`. */
  problems: z.array(z.string()),
  /** The service's own process: names, never values. */
  service: z.strictObject({
    extraNames: z.array(z.string()),
    databaseUrl: z.boolean(),
    secretFile: z.boolean(),
    disableSigusr1: z.boolean(),
  }),
  /** The child's report, or null if it sent none that parses. */
  child: ChildReportSchema.nullable(),
  /** The child's descriptors beyond its pipes and Node's own, as `lsof` named them. */
  openFiles: z.array(z.string()),
});
export type SelftestReply = z.infer<typeof SelftestReplySchema>;

export type SelftestResult = {
  ok: boolean;
  problems: string[];
  /** The backend's own probes, which must be allowed. */
  positiveControl: { tcp: Probe; lookup: Probe };
  /** The service's reply, if it sent one that parses. */
  documents: SelftestReply | undefined;
};

export type DocumentsClient = {
  /** Runs a task on the input; resolves with any reply, and rejects only with DocumentsError. */
  run: (
    task: string,
    input: Uint8Array,
    options?: { deadlineMs?: number },
  ) => Promise<DocumentReply>;
  /** Whether the service answers: `echo` of nothing, checked exactly, within READY_DEADLINE_MS. */
  answers: () => Promise<boolean>;
  /** `selftest` (docs/specs/platform.md, "documents"): the service's checks and its child's
   * probes of the targets, which must all be denied, beside this process's own probes of the
   * backend's port and `localhost`, which must succeed. Never rejects. */
  selftest: (targets: SelftestTargets) => Promise<SelftestResult>;
};

export function createDocumentsClient(
  socketPath: string,
  options: { deadlineMs?: number; maxReplyBytes?: number } = {},
): DocumentsClient {
  const maxReplyBytes = options.maxReplyBytes ?? MAX_REPLY_BYTES;
  const run: DocumentsClient['run'] = (task, input, call = {}) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (outcome: DocumentReply | DocumentsError) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (outcome instanceof DocumentsError) {
          req.destroy();
          reject(outcome);
        } else {
          resolve(outcome);
        }
      };
      const req = request(
        {
          socketPath,
          method: 'POST',
          path: `/run/${encodeURIComponent(task)}`,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(input.byteLength),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxReplyBytes) finish(new DocumentsError('too_large'));
            else chunks.push(chunk);
          });
          res.on('end', () => {
            finish({
              status: res.statusCode ?? 0,
              contentType: res.headers['content-type'] ?? '',
              body: Buffer.concat(chunks),
            });
          });
          res.on('error', (error) => {
            finish(new DocumentsError('unavailable', { cause: error }));
          });
        },
      );
      const deadline = setTimeout(
        () => {
          finish(new DocumentsError('deadline'));
        },
        call.deadlineMs ?? options.deadlineMs ?? DOCUMENTS_DEADLINE_MS,
      );
      req.on('error', (error) => {
        finish(new DocumentsError('unavailable', { cause: error }));
      });
      req.end(input);
    });

  return {
    run,
    answers: async () => {
      try {
        const reply = await run('echo', new Uint8Array(), { deadlineMs: READY_DEADLINE_MS });
        if (reply.status !== 200) return false;
        const body = JSON.parse(reply.body.toString('utf8')) as unknown;
        return (
          typeof body === 'object' &&
          body !== null &&
          (body as { length?: unknown }).length === 0 &&
          (body as { sha256?: unknown }).sha256 === EMPTY_SHA256
        );
      } catch {
        return false;
      }
    },
    selftest: async (targets) => {
      const [tcp, lookup] = await Promise.all([probeTcp(targets.port), probeLookup()]);
      const problems: string[] = [];
      if (tcp !== 'allowed') problems.push(`the backend couldn't reach its own port: ${tcp}`);
      if (lookup !== 'allowed') problems.push(`the backend couldn't look up localhost: ${lookup}`);
      let documents: SelftestReply | undefined;
      try {
        const reply = await run('selftest', new TextEncoder().encode(JSON.stringify(targets)));
        const parsed =
          reply.status === 200
            ? SelftestReplySchema.safeParse(JSON.parse(reply.body.toString('utf8')))
            : undefined;
        if (parsed === undefined) {
          problems.push(`the document service answered selftest with ${String(reply.status)}`);
        } else if (!parsed.success) {
          problems.push("the document service's selftest reply doesn't parse");
        } else {
          documents = parsed.data;
          problems.push(...documents.problems);
          if (!documents.ok && documents.problems.length === 0) {
            problems.push('the document service failed its selftest without saying why');
          }
        }
      } catch (error) {
        problems.push(
          error instanceof DocumentsError ? error.message : "the selftest reply isn't JSON",
        );
      }
      return { ok: problems.length === 0, problems, positiveControl: { tcp, lookup }, documents };
    },
  };
}
