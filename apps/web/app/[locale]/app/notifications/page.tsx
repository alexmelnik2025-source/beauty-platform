'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { PushToggle } from '@/components/PushToggle';
import { ErrorBox, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import type { Notification } from '@/lib/types';
import { formatDay } from '@/lib/time';

export default function NotificationsPage() {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(await api<Notification[]>('/v1/me/notifications', { query: { limit: 100 } }));
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function markAll() {
    await api('/v1/me/notifications/read', { method: 'POST', body: { all: true } });
    window.dispatchEvent(new Event('notifications-read'));
    await load();
  }

  const types = t.notifications.types as Record<string, string>;

  return (
    <>
      <div className="page-head">
        <h1>{t.notifications.title}</h1>
        {items?.some((n) => !n.read) ? (
          <button
            type="button"
            className="btn btn--quiet btn--small"
            onClick={() => void markAll()}
          >
            {t.notifications.markAll}
          </button>
        ) : null}
      </div>
      <div className="page">
        <PushToggle />
        <ErrorBox>{error}</ErrorBox>
        {items === null ? (
          <Spinner />
        ) : items.length === 0 ? (
          <p className="note">{t.notifications.empty}</p>
        ) : (
          <ul className="list">
            {items.map((n) => (
              <li key={n.id} className={`notice-row${n.read ? ' is-read' : ''}`}>
                <span className="dot" aria-hidden="true" />
                <span style={{ display: 'grid', gap: 2 }}>
                  <strong>
                    {types[n.type] ?? n.type}
                    {n.data.by === 'client' ? (
                      <span className="muted small"> · {t.notifications.byClient}</span>
                    ) : null}
                  </strong>
                  <span>
                    {n.data.time} · {formatDay(n.data.date, tag, { short: true })} ·{' '}
                    {n.data.serviceName} · {n.data.staffName}
                    {n.data.customerName ? ` · ${n.data.customerName}` : ''}
                  </span>
                  <Link className="small" href={`/${locale}/app/calendar?date=${n.data.date}`}>
                    {t.notifications.open}
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
