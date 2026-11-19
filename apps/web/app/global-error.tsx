'use client';

import type { ErrorInfo } from 'next/error';
import { ErrorScreen } from '@/components/error-screen';
import { fontVariables } from './fonts';
import './globals.css';

// An error in the root layout itself. This replaces the root layout, so it brings its own <html>,
// fonts and styles (ErrorScreen brings the <title>, since it can't export metadata). Keep it to
// markup that can't fail: if it throws, Next falls back to its built-in screen, whose inline
// <style> production's policy blocks.
export default function GlobalError({ error, retry }: ErrorInfo) {
  return (
    <html lang="en" className={`${fontVariables} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <ErrorScreen error={error} retry={retry} home={false} />
      </body>
    </html>
  );
}
