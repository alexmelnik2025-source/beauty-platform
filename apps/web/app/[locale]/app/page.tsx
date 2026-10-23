'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Spinner } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

export default function CabinetHome() {
  const { locale } = useI18n();
  const router = useRouter();
  useEffect(() => router.replace(`/${locale}/app/calendar`), [locale, router]);
  return <Spinner />;
}
