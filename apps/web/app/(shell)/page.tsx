import { InboxIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';
import { Screen } from '@/components/screen';

export const metadata: Metadata = { title: 'Inbox' };

// Empty until the inbox module exists.
export default function InboxPage() {
  return (
    <Screen title="Inbox">
      <EmptyState
        icon={<InboxIcon />}
        title="No jobs yet"
        description="Screened jobs will show up here, best first, for you to decide on."
      />
    </Screen>
  );
}
