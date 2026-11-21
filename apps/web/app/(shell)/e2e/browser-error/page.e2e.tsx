'use client';

import { useState } from 'react';
import { Screen } from '@/components/screen';
import { Button } from '@/components/ui/button';

// A fixture of the end-to-end build only (next.config.ts, INSTANTE_E2E_PAGES): an error in the
// browser, after hydration, in a shell page. Its button makes the next render throw, which
// app/(shell)/error.tsx catches; an error in the handler itself would reach no error page.
export default function BrowserError() {
  const [broken, setBroken] = useState(false);
  if (broken) throw new Error('a browser error in a shell page, for the end-to-end tests');
  return (
    <Screen title="A browser error">
      <Button
        className="self-start"
        onClick={() => {
          setBroken(true);
        }}
      >
        Break the page
      </Button>
    </Screen>
  );
}
