import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { fontVariables } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  // Each page names itself, so a client navigation changes the title, which is what Next's
  // route announcer reads out.
  title: { default: 'Instante', template: '%s · Instante' },
  description: 'A personal job search: postings that fit you, and a resume for the ones you pick.',
};

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  // Reading the request makes every page render per request, so each gets proxy.ts's fresh
  // nonce, which Next puts on its scripts and stylesheet links (docs/specs/platform.md, "The root
  // layout"). A script of our own reads it from `x-nonce` here, once there is one.
  await headers();
  return (
    <html lang="en" className={`${fontVariables} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        {/* Its own stacking context, as Base UI asks, so a sheet's portal sits above the page. */}
        <div className="isolate flex flex-1 flex-col">{children}</div>
      </body>
    </html>
  );
}
