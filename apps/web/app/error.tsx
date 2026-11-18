'use client';

import type { ErrorInfo } from 'next/error';
import { ErrorScreen } from '@/components/error-screen';

// An error outside the shell's pages: in the shell's layout, or in a page outside the shell.
// Replaces Next's built-in screen, whose inline <style> production's policy blocks.
export default function RootError({ error, retry }: ErrorInfo) {
  return <ErrorScreen error={error} retry={retry} />;
}
