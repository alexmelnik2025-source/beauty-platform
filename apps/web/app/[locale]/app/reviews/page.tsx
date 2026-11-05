'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@/components/Session';
import { Stars } from '@/components/reviews/Stars';
import { ErrorBox, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { useSubmitLock } from '@/lib/submit-lock';
import type { ReviewSettings, SalonReviews } from '@/lib/types';

const HOURS = [1, 2, 3, 6, 12, 24, 48, 72];

/**
 * Task 165b: "Opinie" — the owner and managers switch reviews on and choose when the client is
 * asked ("Jak było?" email); everyone sees the reviews with the client's name (staff only those
 * of their own visits — the server decides).
 */
export default function ReviewsPage() {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const { orgId, location, role } = useSession();
  const base = `/v1/organizations/${orgId}/locations/${location.id}`;
  const manager = role !== 'staff';
  const [list, setList] = useState<SalonReviews | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setList(await api<SalonReviews>(`${base}/reviews`));
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [base, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function more() {
    if (!list?.nextBefore) return;
    try {
      const next = await api<SalonReviews>(`${base}/reviews`, {
        query: { before: list.nextBefore },
      });
      setList({ ...next, items: [...list.items, ...next.items] });
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  const one = new Intl.NumberFormat(tag, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const day = (iso: string) =>
    new Intl.DateTimeFormat(tag, {
      timeZone: location.timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(iso));

  return (
    <>
      <div className="page-head">
        <h1>{t.reviewsCabinet.title}</h1>
      </div>
      <div className="page stack">
        {manager ? <ReviewSettingsForm base={base} onSaved={() => void load()} /> : null}
        <ErrorBox>{error}</ErrorBox>
        {list === null ? (
          error ? null : (
            <Spinner />
          )
        ) : (
          <section className="section" aria-label={t.reviewsCabinet.list}>
            <h2>{t.reviewsCabinet.list}</h2>
            {list.average !== null ? (
              <p>
                <Stars value={list.average} />{' '}
                {fill(t.reviews.summary, {
                  avg: one.format(list.average),
                  count: String(list.count),
                })}
              </p>
            ) : null}
            {list.items.length === 0 ? (
              <p className="note">{t.reviewsCabinet.empty}</p>
            ) : (
              <ul className="list">
                {list.items.map((r) => (
                  <li key={r.id} className="list-row">
                    <span className="grow">
                      <span className="review-head">
                        <Stars value={r.rating} />
                        <strong>{r.customerName ?? t.reviewsCabinet.anonymous}</strong>
                      </span>
                      <span className="small muted">
                        {r.staffName} · {r.serviceName} ·{' '}
                        {fill(t.reviewsCabinet.visit, { date: day(r.visitStartAt) })}
                      </span>
                      {r.text ? <span className="review-text">{r.text}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {list.nextBefore ? (
              <button type="button" className="btn btn--quiet" onClick={() => void more()}>
                {t.reviews.more}
              </button>
            ) : null}
          </section>
        )}
      </div>
    </>
  );
}

function ReviewSettingsForm({ base, onSaved }: { base: string; onSaved: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<ReviewSettings | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const { busy, lock, unlock } = useSubmitLock();

  useEffect(() => {
    api<ReviewSettings>(`${base}/review-settings`)
      .then(setForm)
      .catch((err) => setError(errorText(t, err)));
  }, [base, t]);

  if (!form) return <ErrorBox>{error}</ErrorBox>;

  async function save(current: ReviewSettings) {
    if (!lock()) return;
    setError('');
    setSaved(false);
    try {
      setForm(
        await api<ReviewSettings>(`${base}/review-settings`, {
          method: 'PUT',
          body: {
            version: current.version,
            enabled: current.enabled,
            requestHours: current.requestHours,
          },
        }),
      );
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      unlock();
    }
  }

  return (
    <form
      className="form section"
      aria-label={t.reviewsCabinet.settings}
      onSubmit={(e) => {
        e.preventDefault();
        void save(form);
      }}
    >
      <h2>{t.reviewsCabinet.settings}</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        <span>{t.reviewsCabinet.enabled}</span>
      </label>
      <p className="small muted">{t.reviewsCabinet.hint}</p>
      <label className="field">
        <span>{t.reviewsCabinet.askAfter}</span>
        <select
          value={form.requestHours}
          disabled={!form.enabled}
          onChange={(e) => setForm({ ...form, requestHours: Number(e.target.value) })}
        >
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {fill(t.reviewsCabinet.hours, { n: String(h) })}
            </option>
          ))}
        </select>
      </label>
      <ErrorBox>{error}</ErrorBox>
      {saved ? (
        <p className="note" role="status">
          {t.reviewsCabinet.saved}
        </p>
      ) : null}
      <button className="btn btn--primary" disabled={busy}>
        {t.reviewsCabinet.save}
      </button>
    </form>
  );
}
