'use client';

import { useEffect, type ReactNode } from 'react';
import { startPwa } from '@/lib/pwa';

/** Registers the service worker so "My visits" can be installed on a phone. */
export function ClientAppShell({ children }: { children: ReactNode }) {
  useEffect(() => startPwa(), []);
  return <>{children}</>;
}
