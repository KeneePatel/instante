import type { Metadata } from 'next';
import Link from 'next/link';
import { Screen } from '@/components/screen';
import { buttonVariants } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Not found' };

// Replaces Next's built-in not-found page, whose inline <style> carries no nonce, so production's
// policy blocks it (docs/specs/platform.md, "The root layout"). It serves every unknown address,
// alone in the root layout, and notFound() from a shell page, inside the shell.
export default function NotFound() {
  return (
    <Screen title="Page not found">
      <p className="max-w-prose text-muted-foreground">There’s nothing at this address.</p>
      <Link
        href="/"
        className={buttonVariants({ className: 'self-start max-md:h-11 pointer-coarse:h-11' })}
      >
        Go to Inbox
      </Link>
    </Screen>
  );
}
