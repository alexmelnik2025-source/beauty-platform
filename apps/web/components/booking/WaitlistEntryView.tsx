'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatDay } from '@/lib/time';
import type { PublicWaitlistEntry } from '@/lib/types';
import { ErrorBox, LanguageSwitch, Spinner } from '../ui';

/** Task 50: what the client waits for (salon, service, specialist, day) and "leave the list". */
export function WaitlistEntryView({ token }: { token: string }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [entry, setEntry] = useState<PublicWaitlistEntry | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PublicWaitlistEntry>(`/v1/public/waitlist/${token}`, { auth: false })
      .then(setEntry)
      .catch(() => setMissing(true));
  }, [token]);

  async function leave() {
    setBusy(true);
    setError('');
    try {
      setEntry(
        await api<PublicWaitlistEntry>(`/v1/public/waitlist/${token}/cancel`, {
          method: 'POST',
          auth: false,
        }),
      );
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  if (missing) {
    return (
      <div className="narrow stack">
        <p className="note">{t.errors.NOT_FOUND}</p>
      </div>
    );
  }
  if (!entry) return <Spinner />;

  const query = new URLSearchParams({ service: entry.serviceId });
  if (entry.staffId) query.set('staff', entry.staffId);
  return (
    <div className="booking">
      <header className="salon-head">
        <div className="salon-head-inner">
          <div className="top">
            <span className="small muted">{t.waitlist.title}</span>
            <LanguageSwitch />
          </div>
          <h1 className="salon-name">{entry.salon.name}</h1>
        </div>
      </header>
      <main className="narrow stack">
        <ErrorBox>{error}</ErrorBox>
        <section className="stack" aria-label={t.waitlist.title}>
          <p>
            <strong>{entry.serviceName}</strong>
            {entry.staffName ? ` · ${entry.staffName}` : ''}
          </p>
          <p className="muted">{formatDay(entry.date, tag)}</p>
          <p className="note" role="status">
            {entry.status === 'waiting'
              ? t.waitlist.waiting
              : entry.status === 'notified'
                ? t.waitlist.notified
                : t.waitlist.cancelled}
          </p>
          {entry.status === 'waiting' ? (
            <button type="button" className="btn btn--quiet" disabled={busy} onClick={leave}>
              {t.waitlist.leave}
            </button>
          ) : null}
          <a className="btn" href={`/${locale}/b/${entry.salon.slug}?${query}`}>
            {t.waitlist.book}
          </a>
        </section>
      </main>
    </div>
  );
}
