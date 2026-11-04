'use client';

import { useParams } from 'next/navigation';
import { LegalPage } from '@/components/booking/LegalPage';

export default function RegulaminPage() {
  const { slug } = useParams<{ slug: string }>();
  return <LegalPage slug={slug} doc="terms" />;
}
