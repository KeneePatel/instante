'use client';

import { routes, testRoutes } from '@instante/contract';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createApi } from '@/lib/api';
import { outcomeOf, type Outcome } from '@/lib/call-failure';

// The browser's calls go to its own origin's /api, which the web app rewrites to the backend.
const api = createApi({ base: '' });

/** GET /api/ping from the browser; and, with `?slow=<seconds>` in development and test runs,
 * the slow route, which the rewrite cuts at 30 seconds: what the page then says is what an
 * end-to-end test checks (T19). */
export function BrowserPing() {
  const slow = Number.parseInt(useSearchParams().get('slow') ?? '', 10);
  return (
    <>
      <Ping />
      {Number.isInteger(slow) && <Slow seconds={slow} />}
    </>
  );
}

function Ping() {
  const [outcome, setOutcome] = useState<Outcome<string>>();
  useEffect(() => {
    const controller = new AbortController();
    void outcomeOf(
      api(routes.ping, { signal: controller.signal }).then(({ at }) => `answered at ${at}`),
    ).then((settled) => {
      if (!controller.signal.aborted) setOutcome(settled);
    });
    return () => {
      controller.abort();
    };
  }, []);
  return <Said label="Client Component" outcome={outcome} />;
}

function Slow({ seconds }: { seconds: number }) {
  const [outcome, setOutcome] = useState<Outcome<string>>();
  useEffect(() => {
    const controller = new AbortController();
    void outcomeOf(
      api(testRoutes.slow, { query: { seconds }, signal: controller.signal }).then(
        () => 'answered',
      ),
    ).then((settled) => {
      if (!controller.signal.aborted) setOutcome(settled);
    });
    return () => {
      controller.abort();
    };
  }, [seconds]);
  return <Said label="Slow route" outcome={outcome} />;
}

/** One call's line. What the page can't say goes to the error page, as a render error would. */
function Said({ label, outcome }: { label: string; outcome: Outcome<string> | undefined }) {
  if (outcome !== undefined && 'error' in outcome) throw outcome.error;
  const text =
    outcome === undefined
      ? 'asking the backend…'
      : 'value' in outcome
        ? outcome.value
        : outcome.problem;
  return <p role="status">{`${label}: ${text}`}</p>;
}
