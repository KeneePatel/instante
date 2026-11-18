import { FileTextIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';
import { Screen } from '@/components/screen';

export const metadata: Metadata = { title: 'Resumes' };

// Empty until the tailoring module exists.
export default function ResumesPage() {
  return (
    <Screen title="Resumes">
      <EmptyState
        icon={<FileTextIcon />}
        title="No resumes yet"
        description="A resume you make for a job will show up here, ready to check and download."
      />
    </Screen>
  );
}
