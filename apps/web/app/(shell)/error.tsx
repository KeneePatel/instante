'use client';

import type { ErrorInfo } from 'next/error';
import { ErrorScreen } from '@/components/error-screen';

// An error in one of the shell's pages, shown inside the shell, so the navigation stays.
export default function ShellError({ error, retry }: ErrorInfo) {
  return <ErrorScreen error={error} retry={retry} />;
}
