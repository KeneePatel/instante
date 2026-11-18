import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, activeItem } from './nav.ts';

// The shell's navigation (docs/specs/platform.md, "The shell"): which entry a page's first URL
// segment, as useSelectedLayoutSegment() gives it from app/(shell)/layout.tsx, marks current.

describe('the navigation', () => {
  it('has the four entries in order, Inbox at the root', () => {
    expect(NAV_ITEMS.map(({ label, href }) => [label, href])).toEqual([
      ['Inbox', '/'],
      ['Resumes', '/resumes'],
      ['Applied', '/applied'],
      ['Settings', '/settings'],
    ]);
  });

  it('marks Inbox on the root, which has no segment below the shell', () => {
    expect(activeItem(null)?.label).toBe('Inbox');
  });

  it('marks the entry whose section a page is in, nested pages included', () => {
    // /settings/account's first segment is "settings".
    expect(activeItem('resumes')?.label).toBe('Resumes');
    expect(activeItem('applied')?.label).toBe('Applied');
    expect(activeItem('settings')?.label).toBe('Settings');
  });

  it('marks nothing on a page outside the four sections', () => {
    for (const segment of ['ping', 'inbox', 'Settings', '', '(shell)', '__PAGE__']) {
      expect(activeItem(segment), segment).toBeUndefined();
    }
  });
});
