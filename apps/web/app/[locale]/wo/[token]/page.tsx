'use client';

import { useParams } from 'next/navigation';
import { WaitlistOfferView } from '@/components/booking/WaitlistOfferView';

/** Task 164: the link from the offer email — take the held time or say no. */
export default function WaitlistOfferPage() {
  const { token } = useParams<{ token: string }>();
  return <WaitlistOfferView token={token} />;
}
