'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { useSession } from './Session';
import { LanguageSwitch, Wordmark } from './ui';

export function AppShell({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n();
  const pathname = usePathname() ?? '';
  const session = useSession();
  const items = [{ href: `/${locale}/app/calendar`, label: t.nav.calendar }];

  return (
    <div className="shell">
      <aside className="sidebar">
        <Wordmark href={`/${locale}/app/calendar`} />
        {session.locations.length > 1 ? (
          <label className="field">
            <span className="visually-hidden">Salon</span>
            <select
              value={session.location.id}
              onChange={(e) => session.setLocationId(e.target.value)}
            >
              {session.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="small">
            <strong>{session.location.name}</strong>
            <div className="muted">{session.location.city}</div>
          </div>
        )}
        <nav className="menu">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname.startsWith(item.href) ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="muted">{session.me.user.name}</span>
          <LanguageSwitch />
          <button type="button" className="link-btn" onClick={() => void session.signOut()}>
            {t.common.signOut}
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
      <nav className="bottom-nav">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={pathname.startsWith(item.href) ? 'page' : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
