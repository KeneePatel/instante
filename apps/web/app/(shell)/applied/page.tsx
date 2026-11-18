import { SendIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';
import { Screen } from '@/components/screen';

export const metadata: Metadata = { title: 'Applied' };

// Empty until the applications module exists.
export default function AppliedPage() {
  return (
    <Screen title="Applied">
      <EmptyState
        icon={<SendIcon />}
        title="Nothing applied to yet"
        description="Jobs you mark as applied will show up here, with the resume you sent."
      />
    </Screen>
  );
}
