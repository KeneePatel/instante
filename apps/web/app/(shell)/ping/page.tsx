import { routes } from '@instante/contract';
import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import { Screen } from '@/components/screen';
import { createApi, serverBase } from '@/lib/api';
import { failureText } from '@/lib/call-failure';
import { BrowserPing } from './browser-ping';
import { PdfPreview } from './pdf-preview';

export const metadata: Metadata = { title: 'Ping' };

/** How long the server waits for the backend: under the /api rewrite's 30 seconds, so the
 * server's call and the browser's give up alike. */
const DEADLINE_MS = 25_000;

// The walking skeleton's page (docs/specs/platform.md, "The shell"): GET /api/ping from a
// Server Component, straight to the backend, and from a Client Component, through the /api
// rewrite; and a file route's reply shown through a Blob. No navigation entry marks it.
export default function PingPage() {
  return (
    <Screen title="Ping">
      <Part title="From the server">
        <Suspense fallback={<p className="text-muted-foreground">Asking the backend…</p>}>
          <ServerPing />
        </Suspense>
      </Part>
      <Part title="From the browser">
        <BrowserPing />
      </Part>
      <Part title="A PDF through a Blob">
        <PdfPreview />
      </Part>
    </Screen>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-heading text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

async function ServerPing() {
  return <p>Server Component: {await pingFromServer()}</p>;
}

/** The backend's answer, or what went wrong; anything the page can't say goes to the error
 * page. */
async function pingFromServer(): Promise<string> {
  try {
    const { at } = await createApi({ base: serverBase() })(routes.ping, {
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    return `answered at ${at}`;
  } catch (error) {
    const text = failureText(error);
    if (text === undefined) throw error;
    return text;
  }
}
