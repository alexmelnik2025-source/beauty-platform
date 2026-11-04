'use client';

import { useParams } from 'next/navigation';
import { WaitlistEntryView } from '@/components/booking/WaitlistEntryView';

/** Task 50: the link from the waiting-list email — what the client waits for, and "leave". */
export default function WaitlistPage() {
  const { token } = useParams<{ token: string }>();
  return <WaitlistEntryView token={token} />;
}
