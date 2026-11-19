'use client';

import { testRoutes } from '@instante/contract';
import { useEffect, useState } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { ApiError, createApi } from '@/lib/api';
import { outcomeOf } from '@/lib/call-failure';

const api = createApi({ base: '' });

const NOT_SERVED = 'The sample PDF is served in development and test runs only.';

type Shown = { url: string } | { text: string } | { error: unknown };

/** The sample PDF, a file route's reply, shown through a Blob's object URL as the resume
 * previews will be. Only development and test runs serve it. */
export function PdfPreview() {
  const [shown, setShown] = useState<Shown>();
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    // Real use doesn't register the test routes, and an unknown address there is a 401 or 404.
    const call = api(testRoutes.filePdf, { signal: controller.signal }).catch((error: unknown) => {
      if (error instanceof ApiError && ['unauthenticated', 'not_found'].includes(error.code)) {
        return null;
      }
      throw error;
    });
    void outcomeOf(call).then((settled) => {
      if (controller.signal.aborted) return;
      if (!('value' in settled)) {
        setShown('problem' in settled ? { text: settled.problem } : settled);
      } else if (settled.value === null) {
        setShown({ text: NOT_SERVED });
      } else {
        url = URL.createObjectURL(settled.value);
        setShown({ url });
      }
    });
    return () => {
      controller.abort();
      // The download link needs the URL while the page shows it, so it goes only now.
      if (url !== undefined) URL.revokeObjectURL(url);
    };
  }, []);

  if (shown === undefined) return <p className="text-muted-foreground">Fetching the PDF…</p>;
  // What the page can't say goes to the error page, as a render error would.
  if ('error' in shown) throw shown.error;
  if ('text' in shown) return <p>{shown.text}</p>;
  return (
    <>
      {/* No sandbox attribute: any sandbox stops Chrome and Safari showing a PDF. */}
      <iframe
        src={shown.url}
        title="Sample PDF"
        className="aspect-square w-full max-w-sm rounded-lg border border-border"
      />
      <a
        href={shown.url}
        download="instante-sample.pdf"
        className={buttonVariants({
          variant: 'outline',
          className: 'self-start max-md:h-11 pointer-coarse:h-11',
        })}
      >
        Download the PDF
      </a>
    </>
  );
}
