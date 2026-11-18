import { ShellNav } from '@/components/shell-nav';

// The shell (docs/specs/platform.md, "The shell"): the app's name and its navigation around every
// page in the group. Each page brings its own <main>, so the not-found page, which renders here
// when a page calls notFound() and alone for an unknown address, has one in both places.
export default function ShellLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="flex flex-1 flex-col md:flex-row">
      <ShellNav />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
