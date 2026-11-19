'use client';

import type { ErrorInfo } from 'next/error';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Screen } from '@/components/screen';
import { Button, buttonVariants } from '@/components/ui/button';
import { digestOf } from '@/lib/errors';

/** 44 px on phones, held either way (a coarse pointer). */
const TOUCH = 'max-md:h-11 pointer-coarse:h-11';

/** What app/error.tsx, app/(shell)/error.tsx and app/global-error.tsx show. Never the error's
 * message: in production it is React's placeholder for a server error, and a browser error's own
 * text, which may hold someone's data. A server error's digest is shown as its reference. */
export function ErrorScreen({
  error,
  retry,
  home = true,
}: Pick<ErrorInfo, 'error' | 'retry'> & { home?: boolean }) {
  const reference = digestOf(error);
  const pathname = usePathname();
  // Next clears an error screen only when the address changes, so on the Inbox a link to it
  // would do nothing: only "Try again" is offered there.
  const toInbox = home && pathname !== '/';
  return (
    <Screen title="Something went wrong">
      {/* Its own, since an error page can't export metadata, and a page whose metadata failed
          leaves none. */}
      <title>Error · Instante</title>
      <p className="max-w-prose text-muted-foreground">
        {home ? 'This page couldn’t be shown.' : 'Instante couldn’t be shown.'}{' '}
        {toInbox ? 'Try again, or go to the Inbox.' : 'Try again.'}
      </p>
      <div className="flex flex-wrap gap-3">
        {/* retry asks the server for the page again; reset would only redraw it. */}
        <Button className={TOUCH} onClick={retry}>
          Try again
        </Button>
        {toInbox && (
          <Link href="/" className={buttonVariants({ variant: 'outline', className: TOUCH })}>
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
