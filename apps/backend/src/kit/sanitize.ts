import { AppError } from './errors.ts';

// The one sanitizer for logs, failed jobs and error reports (docs/architecture.md, "Logs and
// errors"). It turns any value into plain JSON-safe data, never throws, and removes what must
// never be kept:
//
// - a database error keeps only its code, constraint and table, since its message and detail
//   can quote the row ("Key (email)=(…) already exists"); an error wrapping one keeps its own
//   name, code and stack, but not its message, which may repeat the database's;
// - Authorization, Cookie and other credential fields are redacted by name: in objects, Maps,
//   Headers, and name/value lists such as Node's rawHeaders;
// - inside any string: bearer and basic credentials, Supabase session cookies, a URL's
//   password and token query parameters;
// - bytes are reduced to their size, long strings are cut, and messages known to quote their
//   input (JSON.parse's SyntaxError, a failed query's parameters) are withheld.

export const REDACTED = '[redacted]';
export const UNREADABLE = '[unreadable]';

/** Field and header names whose value is a credential, matched without regard to case. */
const SECRET_KEY = new RegExp(
  [
    'authorization',
    '^(set-)?cookie$',
    '^sb-.+-auth-token',
    'api[-_]?key',
    'passw(or)?d',
    'secret',
    'private[-_]?key',
    'token$',
    'token[-_]?hash',
    '(database|db)[-_]?url$',
    'connection[-_]?string$',
  ].join('|'),
  'i',
);

const STRING_RULES: readonly [RegExp, string][] = [
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`],
  [/\b(sb-[A-Za-z0-9-]+-auth-token(?:[.-][A-Za-z0-9-]+)?)=[^;\s,]*/g, `$1=${REDACTED}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]*):[^\s/?#@]*@/gi, `$1:${REDACTED}@`],
  [/\b((?:access|refresh|provider)_token|token_hash)=[^&\s#;,]*/gi, `$1=${REDACTED}`],
];

export const MAX_STRING = 2000;
export const MAX_DEPTH = 8;
export const MAX_FRAMES = 10;
const MAX_CAUSES = 5;
/** A V8 stack frame: "    at fn (file:line:column)" or "    at file:line:column". */
const FRAME = /^ {4}at .*:\d+:\d+\)?$/;

export type DatabaseErrorSummary = {
  name: 'DatabaseError';
  code: string;
  constraint?: string;
  table?: string;
};

export function sanitize(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}

function walk(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  try {
    return walkValue(value, depth, ancestors);
  } catch {
    // A throwing getter, a revoked Proxy: a log line must never fail because of its data.
    return UNREADABLE;
  }
}

function walkValue(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') return cleanString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  // undefined, functions and symbols have no JSON form, and are left out.
  if (typeof value !== 'object') return undefined;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `[${String(value.byteLength)} bytes]`;
  }
  if (value instanceof URL) return cleanString(value.href);
  if (ancestors.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[too deep]';
  ancestors.add(value);
  try {
    if (value instanceof Error) return walkError(value, depth, ancestors);
    if (Array.isArray(value)) return walkArray(value, depth, ancestors);
    if (value instanceof Set) return walkArray([...value], depth, ancestors);
    if (value instanceof Map || value instanceof Headers) {
      return walkEntries(value.entries(), depth, ancestors);
    }
    return walkEntries(ownEntries(value), depth, ancestors);
  } finally {
    // Only an object inside itself is circular; one shared twice is written twice.
    ancestors.delete(value);
  }
}

/** An array of names and values, such as rawHeaders or one [name, value] pair, is redacted by
 * name like an object's fields. */
function walkArray(items: unknown[], depth: number, ancestors: WeakSet<object>): unknown[] {
  const pairs =
    items.length % 2 === 0 && items.every((item, i) => i % 2 === 1 || typeof item === 'string');
  return items.map((item, i) => {
    const name = pairs && i % 2 === 1 ? items[i - 1] : undefined;
    return typeof name === 'string' && SECRET_KEY.test(name)
      ? REDACTED
      : walk(item, depth + 1, ancestors);
  });
}

/** Each own field read on its own, so one throwing getter costs only that field. */
function* ownEntries(value: object): Generator<readonly [unknown, unknown]> {
  for (const key of Object.keys(value)) {
    let item: unknown;
    try {
      item = (value as Record<string, unknown>)[key];
    } catch {
      item = UNREADABLE;
    }
    yield [key, item];
  }
}

function walkEntries(
  entries: Iterable<readonly [unknown, unknown]>,
  depth: number,
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    const name = typeof key === 'string' ? key : textOf(key);
    out[name] = SECRET_KEY.test(name) ? REDACTED : walk(item, depth + 1, ancestors);
  }
  return out;
}

function walkError(error: Error, depth: number, ancestors: WeakSet<object>): unknown {
  if (isDatabaseError(error)) return summaryOf(error);

  const name = typeof error.name === 'string' ? cleanString(error.name) : 'Error';
  const out: Record<string, unknown> = { name };
  out['message'] = messageOf(error);
  const { code } = error as { code?: unknown };
  if (typeof code === 'string') out['code'] = cleanString(code);
  else if (typeof code === 'number') out['code'] = code;
  const frames = framesOf(error);
  if (frames.length > 0) out['stack'] = frames;
  if (error.cause !== undefined) out['cause'] = walk(error.cause, depth + 1, ancestors);
  if (error instanceof AggregateError) {
    out['errors'] = walk(error.errors as unknown, depth + 1, ancestors);
  }
  return out;
}

function messageOf(error: Error): string {
  if (error instanceof AppError) return cleanString(error.message);
  if (error instanceof SyntaxError) return '[withheld: it can quote its input]';
  if ('params' in error) return '[withheld: it quotes the query parameters]';
  if (hasDatabaseCause(error)) return "[withheld: it can repeat the database's message]";
  return typeof error.message === 'string' ? cleanString(error.message) : UNREADABLE;
}

/** Frames only: the stack opens with the message, which may span lines or be withheld. */
function framesOf(error: Error): string[] {
  if (typeof error.stack !== 'string') return [];
  // name and message are typed as strings, but a thrown value can carry anything.
  const header = `${textOf(error.name)}: ${textOf(error.message)}`;
  const stack = error.stack.startsWith(header) ? error.stack.slice(header.length) : error.stack;
  return stack
    .split('\n')
    .filter((line) => FRAME.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => cleanString(line.trim()));
}

/** A PostgreSQL error as `pg` raises it: a five-character SQLSTATE and a severity. */
function isDatabaseError(error: Error): boolean {
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && typeof severity === 'string';
}

function hasDatabaseCause(error: Error): boolean {
  let current: unknown = error.cause;
  for (let i = 0; i < MAX_CAUSES && current instanceof Error; i++) {
    if (isDatabaseError(current)) return true;
    current = current.cause;
  }
  return false;
}

function summaryOf(error: Error): DatabaseErrorSummary {
  const { code, constraint, table } = error as unknown as {
    code: string;
    constraint?: unknown;
    table?: unknown;
  };
  return {
    name: 'DatabaseError',
    code,
    ...(typeof constraint === 'string' ? { constraint: cleanString(constraint) } : {}),
    ...(typeof table === 'string' ? { table: cleanString(table) } : {}),
  };
}

function textOf(value: unknown): string {
  try {
    return String(value);
  } catch {
    return UNREADABLE;
  }
}

function cleanString(text: string): string {
  let clean = text;
  for (const [pattern, replacement] of STRING_RULES) clean = clean.replace(pattern, replacement);
  if (clean.length <= MAX_STRING) return clean;
  return `${clean.slice(0, MAX_STRING)}… [${String(clean.length - MAX_STRING)} more characters]`;
}
