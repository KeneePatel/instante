// The shell's navigation (docs/specs/platform.md, "The shell"): its four entries, each with the
// first URL segment of the pages it covers. A section's own pages, /settings/account included,
// sit under its segment; Inbox is the root, which has none.

type Entry = {
  readonly label: string;
  readonly href: string;
  /** The first segment below the shell, as useSelectedLayoutSegment() gives it there. */
  readonly segment: string | null;
};

export const NAV_ITEMS = [
  { label: 'Inbox', href: '/', segment: null },
  { label: 'Resumes', href: '/resumes', segment: 'resumes' },
  { label: 'Applied', href: '/applied', segment: 'applied' },
  { label: 'Settings', href: '/settings', segment: 'settings' },
] as const satisfies readonly Entry[];

export type NavItem = (typeof NAV_ITEMS)[number];

/** The entry the current page is in, or none for a page outside the four (the ping page). */
export function activeItem(segment: string | null): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.segment === segment);
}
