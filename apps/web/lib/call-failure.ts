import { ApiError, UNREACHABLE } from './api.ts';

/** What a page shows for a call to the backend that failed: "can't reach its server" for an
 * outage, or when the caller's own deadline (`AbortSignal.timeout`) ran out; the contract's
 * message and code for its other errors. Anything else, a caller's abort or a bug, is no answer
 * here: the caller lets it through, to the error page. */
export function failureText(error: unknown): string | undefined {
  if (error instanceof ApiError) {
    return error.code === 'upstream_unavailable' ? UNREACHABLE : `${error.message} (${error.code})`;
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') return UNREACHABLE;
  return undefined;
}

/** How a call ended, for a page to show: its value, the text for what went wrong, or an error
 * only the error page can say. */
export type Outcome<T> = { value: T } | { problem: string } | { error: unknown };

/** Waits for a call and says how it ended. */
export async function outcomeOf<T>(call: Promise<T>): Promise<Outcome<T>> {
  try {
    return { value: await call };
  } catch (error) {
    const problem = failureText(error);
    return problem === undefined ? { error } : { problem };
  }
}
