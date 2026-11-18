'use client';

import type { ErrorInfo } from 'next/error';
import Link from 'next/link';
import { Screen } from '@/components/screen';
import { Button, buttonVariants } from '@/components/ui/button';
import { digestOf } from '@/lib/errors';

/** What app/error.tsx, app/(shell)/error.tsx and app/global-error.tsx show. Never the error's
 * message: in production it is React's placeholder for a server error, and a browser error's own
 * text, which may hold someone's data. A server error's digest is shown as its reference. */
export function ErrorScreen({
  error,
  retry,
  home = true,
}: Pick<ErrorInfo, 'error' | 'retry'> & { home?: boolean }) {
  const reference = digestOf(error);
  return (
    <Screen title="Something went wrong">
      <p className="max-w-prose text-muted-foreground">
        {home
          ? 'This page couldn’t be shown. Try again, or go to the Inbox.'
          : 'Instante couldn’t be shown. Try again.'}
      </p>
      <div className="flex flex-wrap gap-3">
        {/* retry asks the server for the page again; reset would only redraw it. */}
        <Button className="max-md:h-11" onClick={retry}>
          Try again
        </Button>
        {home && (
          <Link
            href="/"
            className={buttonVariants({ variant: 'outline', className: 'max-md:h-11' })}
          >
            Go to Inbox
          </Link>
        )}
      </div>
      {reference !== undefined && (
        <p className="text-sm text-muted-foreground">Reference: {reference}</p>
      )}
    </Screen>
  );
}
