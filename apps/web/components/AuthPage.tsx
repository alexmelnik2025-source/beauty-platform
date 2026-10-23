'use client';

import type { ReactNode } from 'react';
import { LanguageSwitch, Wordmark } from './ui';

export function AuthPage({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <header>
        <Wordmark />
        <LanguageSwitch />
      </header>
      <main className="narrow auth-card">{children}</main>
    </div>
  );
}
