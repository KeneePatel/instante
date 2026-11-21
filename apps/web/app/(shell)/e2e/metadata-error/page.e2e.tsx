import type { Metadata } from 'next';
import { Screen } from '@/components/screen';

// A fixture of the end-to-end build only (next.config.ts, INSTANTE_E2E_PAGES): a page whose
// metadata fails, which leaves the error page no title but its own.
export function generateMetadata(): Promise<Metadata> {
  return Promise.reject(new Error('metadata that fails, for the end-to-end tests'));
}

export default function MetadataError() {
  return <Screen title="Metadata that fails" />;
}
