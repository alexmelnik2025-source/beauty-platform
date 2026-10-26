'use client';

import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { SessionProvider } from '@/components/Session';
import { startPwa } from '@/lib/pwa';

export function CabinetLayout({ children }: { children: ReactNode }) {
  const onboarding = (usePathname() ?? '').endsWith('/app/onboarding');
  useEffect(() => startPwa(), []);
  return (
    <SessionProvider>{onboarding ? children : <AppShell>{children}</AppShell>}</SessionProvider>
  );
}
