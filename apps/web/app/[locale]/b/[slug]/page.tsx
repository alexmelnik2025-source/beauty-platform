'use client';

import { useParams } from 'next/navigation';
import { BookingFlow } from '@/components/booking/BookingFlow';

export default function BookingPage() {
  const { slug } = useParams<{ slug: string }>();
  return <BookingFlow slug={slug} />;
}
