// A fixture of the end-to-end build only (next.config.ts, INSTANTE_E2E_PAGES): a server error
// in a page outside the shell, which app/error.tsx shows alone.
export default function RootError(): never {
  throw new Error('a server error outside the shell, for the end-to-end tests');
}
