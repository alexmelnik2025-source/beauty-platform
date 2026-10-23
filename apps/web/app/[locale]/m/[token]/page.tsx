'use client';

import { useParams } from 'next/navigation';
import { ManageAppointment } from '@/components/booking/ManageAppointment';

export default function ManagePage() {
  const { token } = useParams<{ token: string }>();
  return <ManageAppointment token={token} />;
}
