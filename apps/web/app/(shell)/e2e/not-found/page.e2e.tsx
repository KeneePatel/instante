import { notFound } from 'next/navigation';

// A fixture of the end-to-end build only (next.config.ts, INSTANTE_E2E_PAGES): notFound() from a
// shell page, which shows the not-found page inside the shell.
export default function NotFoundInShell(): never {
  notFound();
}
