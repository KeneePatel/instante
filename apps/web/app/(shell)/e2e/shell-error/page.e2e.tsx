// A fixture of the end-to-end build only (next.config.ts, INSTANTE_E2E_PAGES): a server error
// in a shell page, which app/(shell)/error.tsx shows inside the shell.
export default function ShellError(): never {
  throw new Error('a server error in a shell page, for the end-to-end tests');
}
