import { createAdaptorServer } from '@hono/node-server';
import { lstatSync, realpathSync, statSync, chmodSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { systemClock, type Clock } from '../kit/clock.ts';
import { loadConfig, processRuntime, type Runtime } from '../kit/config.ts';
import { createLogger, type Logger, type Sink } from '../kit/logger.ts';
import { CHILD_TIMEOUT_MS, runChild } from './run-child.ts';

// The document service (docs/specs/platform.md, "documents"; ROLE=documents): a Hono app on the
// Unix socket DOCUMENTS_SOCKET, with no TCP port and one route, POST /run/:task. It holds no
// secret and no database URL, and is treated as compromised (docs/threat-model.md). Each job
// gets a folder from mkdtemp; the service writes the input bytes there itself, runs the task's
// child (run-child.ts) and removes the folder.

export type Task = {
  /** The child's script, an absolute path inside the granted code. */
  script: string;
  /** The reply's media type: what the child writes on stdout. */
  contentType: string;
};

export const TASKS: Readonly<Record<string, Task>> = {
  echo: {
    script: fileURLToPath(new URL('./tasks/echo.ts', import.meta.url)),
    contentType: 'application/json',
  },
};

/** The largest input any task takes: a job board's answer, 50 MB decompressed
 * (docs/architecture.md, "Limits"; the spec writes MiB where it means them). Tasks check their
 * own, smaller caps. */
export const MAX_INPUT_BYTES = 50_000_000;

/** The repository (or a release folder) holding this file: apps/backend/src/documents/. */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** The code the children may read, by real path: the backend's source, the contract package and
 * the installed packages. */
export function grantedCode(root: string = ROOT): string[] {
  return ['apps/backend/src', 'packages/contract', 'node_modules/.pnpm'].map((part) =>
    realpathSync(path.join(root, part)),
  );
}

export type DocumentsOptions = {
  logger: Logger;
  tasks?: Readonly<Record<string, Task>>;
  grants?: readonly string[];
  /** Where job folders are made: a real path. */
  jobsRoot?: string;
  maxInputBytes?: number;
  timeoutMs?: number;
  /** Aborted when the service stops, which kills the children still running. */
  signal?: AbortSignal;
};

type ErrorCode = 'unknown_task' | 'too_large' | 'failed' | 'timed_out' | 'too_much_output';

export function createDocumentsApp(options: DocumentsOptions): Hono {
  const tasks = options.tasks ?? TASKS;
  const grants = options.grants ?? grantedCode();
  const jobsRoot = options.jobsRoot ?? realpathSync(tmpdir());
  const maxInputBytes = options.maxInputBytes ?? MAX_INPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? CHILD_TIMEOUT_MS;
  const { logger } = options;
  const refuse = (c: Context, status: 404 | 413 | 500 | 504, code: ErrorCode) =>
    c.json({ error: { code } }, status);

  const app = new Hono();
  app.post(
    '/run/:task',
    bodyLimit({ maxSize: maxInputBytes, onError: (c) => refuse(c, 413, 'too_large') }),
    async (c) => {
      const name = c.req.param('task');
      const task = Object.hasOwn(tasks, name) ? tasks[name] : undefined;
      if (task === undefined) return refuse(c, 404, 'unknown_task');
      const input = new Uint8Array(await c.req.arrayBuffer());
      const jobFolder = await mkdtemp(path.join(jobsRoot, 'instante-job-'));
      try {
        await writeFile(path.join(jobFolder, 'input'), input, { flag: 'wx', mode: 0o600 });
        const result = await runChild({
          script: task.script,
          args: [],
          jobFolder,
          grants,
          timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (result.ok) {
          logger.info('documents.run', {
            task: name,
            ms: result.ms,
            inputBytes: input.byteLength,
            outputBytes: result.stdout.byteLength,
          });
          return c.body(new Uint8Array(result.stdout), 200, { 'content-type': task.contentType });
        }
        // The child's stderr stays in this Mac's log: it may quote the document.
        logger.warn('documents.failed', {
          task: name,
          reason: result.reason,
          code: result.code,
          signal: result.signal,
          ms: result.ms,
          stderr: result.stderr,
        });
        if (result.reason === 'timed_out') return refuse(c, 504, 'timed_out');
        if (result.reason === 'too_much_output') return refuse(c, 500, 'too_much_output');
        return refuse(c, 500, 'failed');
      } finally {
        await rm(jobFolder, { recursive: true, force: true });
      }
    },
  );
  app.notFound((c) => refuse(c, 404, 'unknown_task'));
  app.onError((error, c) => {
    logger.error('documents.error', { error });
    return refuse(c, 500, 'failed');
  });
  return app;
}

export type RunningDocuments = {
  socket: string;
  /** Stops taking connections, kills the children still running, and removes the socket. */
  close: () => Promise<void>;
};

export type StartDocumentsOptions = {
  env: Readonly<Record<string, string | undefined>>;
  runtime?: Runtime;
  clock?: Clock;
  sink?: Sink;
  /** The app's own settings, for tests: the tasks, grants, limits and where jobs go. */
  documents?: Omit<DocumentsOptions, 'logger' | 'signal'>;
};

/** Throws ConfigError when the configuration refuses to start. */
export async function startDocuments(options: StartDocumentsOptions): Promise<RunningDocuments> {
  const config = loadConfig(options.env, options.runtime ?? processRuntime());
  if (config.role !== 'documents') throw new Error(`startDocuments: ROLE=${config.role}`);
  const logger = createLogger({
    clock: options.clock ?? systemClock,
    fields: { role: 'documents' },
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  });
  const socket = config.documentsSocket;
  privateFolder(path.dirname(socket));

  const stopping = new AbortController();
  const app = createDocumentsApp({ ...options.documents, logger, signal: stopping.signal });
  // The requests still being handled: stopping waits for them, since each removes its job's
  // folder only once its child is gone.
  const handling = new Set<Promise<unknown>>();
  const server = createAdaptorServer({
    fetch: (request, env) => {
      const reply: Promise<unknown> = Promise.resolve(app.fetch(request, env)).finally(() => {
        handling.delete(reply);
      });
      handling.add(reply);
      return reply;
    },
  }) as Server;
  await listenOn(server, socket);
  // The folder already keeps everyone else out; the socket itself is the owner's too.
  chmodSync(socket, 0o600);
  logger.info('documents.listening', { socket, env: config.env });

  return {
    socket,
    close: async () => {
      logger.info('documents.stopping', {});
      stopping.abort();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
      // After the connections close, so a stalled upload can't hold the stop: its body read
      // fails at once. The jobs end as their killed children do, each removing its folder.
      await Promise.allSettled(handling);
      rmSync(socket, { force: true });
    },
  };
}

/** The socket's folder must be the owner's alone: browsers can't reach a socket, but every
 * local user could connect to one in an open folder. */
function privateFolder(folder: string): void {
  const stat = statSync(folder);
  const where = "The document service's socket folder";
  if (!stat.isDirectory()) throw new Error(`${where} isn't a folder`);
  if (stat.uid !== process.getuid?.()) {
    throw new Error(`${where} must be yours, not uid ${String(stat.uid)}'s`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${where} must be yours, mode 0700, not ${(stat.mode & 0o777).toString(8)}`);
  }
}

/** Listens on the socket. A socket file left by a process that's gone (nothing answers on it)
 * is replaced; anything else at the path refuses, as does a service answering there. Checked
 * before binding, since macOS's bind() follows a symlink that points nowhere and would put the
 * socket outside the checked folder. */
async function listenOn(server: Server, socket: string): Promise<void> {
  const existing = lstatSync(socket, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (!existing.isSocket()) throw inUse(socket, "something that isn't a socket");
    if (await answers(socket)) throw inUse(socket, 'a service that answers');
    rmSync(socket);
  }
  await listen(server, socket);
}

function inUse(socket: string, by: string): Error {
  return Object.assign(new Error(`${socket} is held by ${by}`), { code: 'EADDRINUSE' });
}

function listen(server: Server, socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function answers(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socket);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      resolve(false);
    });
  });
}
