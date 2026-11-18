import { SettingsIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';
import { Screen } from '@/components/screen';

export const metadata: Metadata = { title: 'Settings' };

// Empty until the settings module exists; accounts adds Settings › Account at /settings/account.
export default function SettingsPage() {
  return (
    <Screen title="Settings">
      <EmptyState
        icon={<SettingsIcon />}
        title="Nothing to set yet"
        description="Your search, eligibility, screening and resume settings will be here."
      />
    </Screen>
  );
}
