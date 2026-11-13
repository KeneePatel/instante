import type { Clock } from './clock.ts';
import { sanitize } from './sanitize.ts';

// A JSON logger on console: one line per event, every field passed through the sanitizer.
// No logging library (docs/specs/platform.md, "Dependencies").

export type Level = 'info' | 'warn' | 'error';
export type Fields = Record<string, unknown>;

export type Logger = {
  info: (event: string, fields?: Fields) => void;
  warn: (event: string, fields?: Fields) => void;
  error: (event: string, fields?: Fields) => void;
  /** A logger that adds these fields to every line, such as a request id. */
  child: (fields: Fields) => Logger;
};

/** Where lines go: console by default, so the launcher's log files catch both streams. */
export type Sink = { out: (line: string) => void; err: (line: string) => void };

export const consoleSink: Sink = {
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
};

const RESERVED = new Set(['at', 'level', 'event']);

export function createLogger(options: { clock: Clock; sink?: Sink; fields?: Fields }): Logger {
  const { clock, sink = consoleSink, fields: base = {} } = options;
  const write = (level: Level, event: string, fields: Fields = {}) => {
    const line: Record<string, unknown> = { at: clock.now().toISOString(), level, event };
    // The sanitizer reads each field on its own and never throws, so a field that can't be
    // read costs only itself, and logging never takes a request down.
    const clean = { ...plain(sanitize(base)), ...plain(sanitize(fields)) };
    for (const [key, value] of Object.entries(clean)) {
      if (!RESERVED.has(key)) line[key] = value;
    }
    (level === 'error' ? sink.err : sink.out)(JSON.stringify(line));
  };
  return {
    info: (event, fields) => {
      write('info', event, fields);
    },
    warn: (event, fields) => {
      write('warn', event, fields);
    },
    error: (event, fields) => {
      write('error', event, fields);
    },
    child: (fields) =>
      createLogger({ clock, sink, fields: { ...base, ...plain(sanitize(fields)) } }),
  };
}

function plain(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
