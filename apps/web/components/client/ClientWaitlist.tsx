'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatDay } from '@/lib/time';
import type { WaitlistEntry } from '@/lib/types';
import { ErrorBox } from '../ui';

/** "My visits" → upcoming: the days the client waits for (task 51), with Book and Leave. */
export function ClientWaitlist({ onSignedOut }: { onSignedOut: () => void }) {
  const { t, locale } = useI18n();
  const w = t.waitlist;
  const tag = LOCALE_TAGS[locale];
  const [items, setItems] = useState<WaitlistEntry[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(
        (await api<{ items: WaitlistEntry[] }>('/v1/client/waitlist', { auth: false })).items,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      // Otherwise the visits below still show; the list simply stays hidden.
    }
  }, [onSignedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  async function leave(id: string) {
    setError('');
    try {
      await api(`/v1/client/waitlist/${id}`, { method: 'DELETE', auth: false });
      setItems((list) => list.filter((e) => e.id !== id));
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  if (items.length === 0) return error ? <ErrorBox>{error}</ErrorBox> : null;
  return (
    <section className="stack" aria-labelledby="client-waitlist" style={{ gap: 8 }}>
      <h2 id="client-waitlist" className="muted small">
        {w.title}
      </h2>
      <ErrorBox>{error}</ErrorBox>
      <ul className="list">
        {items.map((e) => {
          const params = new URLSearchParams({ service: e.service.id });
          if (e.staff) params.set('staff', e.staff.id);
          return (
            <li key={e.id}>
              <span className="grow list-row">
                <span className="grow">
                  <strong>
                    {formatDay(e.date, tag, { short: true })} · {e.service.name}
                  </strong>
                  <span className="small">
                    {e.salon.name} · {e.staff?.displayName ?? w.any}
                  </span>
                  <span className="small muted">{e.notifiedAt ? w.notified : w.waiting}</span>
                </span>
              </span>
              <Link
                className="btn btn--quiet btn--small"
                href={`/${locale}/b/${e.salon.slug}?${params.toString()}`}
              >
                {t.booking.bookVisit}
              </Link>
              <button
                type="button"
                className="link-btn small"
                aria-label={`${w.leave}: ${e.service.name}, ${formatDay(e.date, tag)}`}
                onClick={() => void leave(e.id)}
              >
                {w.leave}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
