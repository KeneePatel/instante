'use client';

import {
  FileTextIcon,
  InboxIcon,
  MenuIcon,
  SendIcon,
  SettingsIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';
import { useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { NAV_ITEMS, activeItem, type NavItem } from '@/lib/nav';
import { cn } from '@/lib/utils';

// The shell's navigation (the owner's choice, 2026-11-18): a side nav from md up, and on phones a
// menu button opening the same links in a sheet. Nothing is stored. Rendered by
// app/(shell)/layout.tsx, where the selected segment is the page's section.

const ICONS: Record<NavItem['label'], LucideIcon> = {
  Inbox: InboxIcon,
  Resumes: FileTextIcon,
  Applied: SendIcon,
  Settings: SettingsIcon,
};

export function ShellNav() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <header className="flex items-center gap-1 border-b px-2 py-1 md:hidden">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger render={<Button variant="ghost" size="icon" className="size-11" />}>
            <MenuIcon />
            <span className="sr-only">Menu</span>
          </SheetTrigger>
          <SheetContent side="left" showCloseButton={false}>
            <SheetHeader className="flex-row items-center justify-between py-2 pr-2">
              <SheetTitle>Instante</SheetTitle>
              <SheetClose render={<Button variant="ghost" size="icon" className="size-11" />}>
                <XIcon />
                <span className="sr-only">Close the menu</span>
              </SheetClose>
            </SheetHeader>
            <nav aria-label="Main" className="px-2">
              <NavLinks
                onNavigate={() => {
                  setMenuOpen(false);
                }}
              />
            </nav>
          </SheetContent>
        </Sheet>
        <p className="font-heading text-base font-semibold">Instante</p>
      </header>
      <aside className="sticky top-0 hidden h-svh w-56 shrink-0 flex-col gap-4 border-r border-sidebar-border bg-sidebar p-3 text-sidebar-foreground md:flex">
        <p className="px-2.5 py-1 font-heading text-base font-semibold">Instante</p>
        <nav aria-label="Main">
          <NavLinks />
        </nav>
      </aside>
    </>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const current = activeItem(useSelectedLayoutSegment());
  return (
    <ul className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => {
        const Icon = ICONS[item.label];
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item === current ? 'page' : undefined}
              className={cn(
                buttonVariants({ variant: 'ghost' }),
                // 44 px on phones; the current page shows by its background and weight.
                'h-11 w-full justify-start gap-2 md:h-8',
                'aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-semibold aria-[current=page]:text-sidebar-accent-foreground',
              )}
              {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
            >
              <Icon />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
