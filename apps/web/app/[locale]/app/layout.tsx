'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { SessionProvider } from '@/components/Session';

export default function CabinetLayout({ children }: { children: ReactNode }) {
  const onboarding = (usePathname() ?? '').endsWith('/app/onboarding');
  return (
    <SessionProvider>{onboarding ? children : <AppShell>{children}</AppShell>}</SessionProvider>
  );
}
