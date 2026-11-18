import type { ReactNode } from 'react';

/** One screen's main content under its title. Every page, the not-found page and the error pages
 * render one, so each has exactly one <main> and one <h1>, inside the shell or alone. */
export function Screen({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="flex flex-1 flex-col gap-6 px-4 py-6 md:px-10 md:py-8">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </main>
  );
}
