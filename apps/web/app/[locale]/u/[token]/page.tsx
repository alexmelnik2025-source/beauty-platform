'use client';

import { useParams } from 'next/navigation';
import { Unsubscribe } from '@/components/booking/Unsubscribe';

/** Task 165c: the "unsubscribe" link of the salon's emails — one click withdraws the consent. */
export default function UnsubscribePage() {
  const { token } = useParams<{ token: string }>();
  return <Unsubscribe token={decodeURIComponent(token)} />;
}
