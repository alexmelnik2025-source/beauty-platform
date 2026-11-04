'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useI18n, type Locale } from '@/lib/i18n';
import type { Dict } from '@/lib/i18n/pl';
import type { UnreadCount } from '@/lib/types';
import { InstallApp } from './InstallApp';
import { useSession } from './Session';
import { LanguageSwitch, Wordmark } from './ui';

interface MenuItem {
  href: string;
  label: string;
  /** Shown in the phone's bottom bar (the rest is under "More"). */
  bottom?: boolean;
  badge?: boolean;
}

/** Sections by role: staff see their calendar, notifications and schedule only. */
export function menuItems(
  t: Dict,
  locale: Locale,
  session: {
    role: string;
    permissions: Record<string, boolean>;
    me: { isPlatformAdmin: boolean };
  },
): MenuItem[] {
  const at = (path: string) => `/${locale}/app/${path}`;
  const manager = session.role !== 'staff';
  const items: (MenuItem | false)[] = [
    { href: at('calendar'), label: t.nav.calendar, bottom: true },
    manager && { href: at('clients'), label: t.nav.clients, bottom: true },
    { href: at('notifications'), label: t.nav.notifications, bottom: true, badge: true },
    manager && { href: at('services'), label: t.nav.services },
    manager && { href: at('team'), label: t.nav.team },
    manager && { href: at('loyalty'), label: t.nav.loyalty },
    (manager || session.permissions.viewOwnEarnings === true) && {
      href: at('reports'),
      label: t.reports.title,
    },
    !manager && { href: at('schedule'), label: t.more.schedule },
    manager && { href: at('settings'), label: t.nav.settings },
    session.me.isPlatformAdmin && { href: at('admin/outbox'), label: t.more.admin },
  ];
  return items.filter((i): i is MenuItem => Boolean(i));
}

/** Unread notifications, checked every 30 s like the calendar. */
function useUnread(): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const check = () =>
      void api<UnreadCount>('/v1/me/notifications/unread-count')
        .then((r) => setUnread(r.unread))
        .catch(() => undefined);
    check();
    const timer = window.setInterval(check, 30_000);
    window.addEventListener('notifications-read', check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('notifications-read', check);
    };
  }, []);
  return unread;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n();
  const pathname = usePathname() ?? '';
  const session = useSession();
  const unread = useUnread();
  const items = menuItems(t, locale, session);
  const bottom = [
    ...items.filter((i) => i.bottom),
    { href: `/${locale}/app/more`, label: t.more.title },
  ];
  const current = (href: string) => (pathname.startsWith(href) ? 'page' : undefined);
  const badge = (item: MenuItem) =>
    item.badge && unread > 0 ? (
      <span className="badge" aria-label={`${unread}`}>
        {unread > 99 ? '99+' : unread}
      </span>
    ) : null;

  return (
    <div className="shell">
      <aside className="sidebar">
        <Wordmark href={`/${locale}/app/calendar`} />
        {session.locations.length > 1 ? (
          <label className="field">
            <span className="visually-hidden">{t.settings.salon}</span>
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
            <Link key={item.href} href={item.href} aria-current={current(item.href)}>
              <span style={{ flex: 1 }}>{item.label}</span>
              {badge(item)}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="muted">{session.me.user.name}</span>
          <LanguageSwitch />
          <InstallApp compact />
          <button type="button" className="link-btn" onClick={() => void session.signOut()}>
            {t.common.signOut}
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
      <nav className="bottom-nav" style={{ gridTemplateColumns: `repeat(${bottom.length}, 1fr)` }}>
        {bottom.map((item) => (
          <Link key={item.href} href={item.href} aria-current={current(item.href)}>
            <span>
              {item.label} {badge(item)}
            </span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
