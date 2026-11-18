/** The digest Next gives a Server Component's error, which the web log prints with the error,
 * so a page can show it as a reference. In production the error's message is React's
 * placeholder for a server error and the raw text for a browser's own, so a page shows neither. */
export function digestOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('digest' in error)) return undefined;
  const { digest } = error;
  return typeof digest === 'string' && digest !== '' && digest.length <= 64 ? digest : undefined;
}
