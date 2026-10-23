'use client';

import Link from 'next/link';
import { useSession } from '@/components/Session';
import { LanguageSwitch } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { menuItems } from '@/components/AppShell';

/** Phone menu: everything that does not fit in the bottom bar. */
export default function MorePage() {
  const { t, locale } = useI18n();
  const session = useSession();
  const items = menuItems(t, locale, session).filter((i) => !i.bottom);
  return (
    <>
      <div className="page-head">
        <h1>{t.more.title}</h1>
      </div>
      <div className="page">
        <div className="small">
          <strong>{session.location.name}</strong>
          <div className="muted">{session.me.user.name}</div>
        </div>
        {session.locations.length > 1 ? (
          <label className="field">
            <span>{t.settings.salon}</span>
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
        ) : null}
        <ul className="list">
          {items.map((i) => (
            <li key={i.href}>
              <Link className="list-row" href={i.href}>
                <span className="grow">
                  <strong>{i.label}</strong>
                </span>
                ›
              </Link>
            </li>
          ))}
        </ul>
        <div className="field">
          <span className="small muted">{t.more.language}</span>
          <LanguageSwitch />
        </div>
        <button type="button" className="btn btn--quiet" onClick={() => void session.signOut()}>
          {t.common.signOut}
        </button>
      </div>
    </>
  );
}
