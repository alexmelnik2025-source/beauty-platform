'use client';

import { useParams } from 'next/navigation';
import { ClientVisit } from '@/components/client/ClientVisit';

export default function ClientVisitPage() {
  const { id } = useParams<{ id: string }>();
  return <ClientVisit id={id} />;
}
