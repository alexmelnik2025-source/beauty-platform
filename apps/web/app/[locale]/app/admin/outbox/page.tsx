'use client';

import { useCallback, useEffect, useState } from 'react';
import { ErrorBox, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';

interface Stats {
  status: 'ok' | 'warning';
  pending: number;
  due: number;
  oldestDueSeconds: number;
  failed: number;
  sentLast24h: number;
}

interface Failed {
  id: string;
  type: string;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string;
}

/** Platform administrators only: health of the email queue and resending failed emails. */
export default function OutboxPage() {
  const { t, locale } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState<Failed[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, f] = await Promise.all([
        api<Stats>('/v1/admin/outbox'),
        api<Failed[]>('/v1/admin/outbox/failed'),
      ]);
      setStats(s);
      setFailed(f);
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function retry(body: object) {
    try {
      const res = await api<{ requeued: number }>('/v1/admin/outbox/retry', {
        method: 'POST',
        body,
      });
      setMessage(fill(t.admin.requeued, { count: String(res.requeued) }));
      await load();
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  if (!stats) return error ? <ErrorBox>{error}</ErrorBox> : <Spinner />;

  return (
    <>
      <div className="page-head">
        <h1>{t.admin.title}</h1>
        <span className="chip">{stats.status === 'ok' ? t.admin.ok : t.admin.warning}</span>
      </div>
      <div className="page">
        <ErrorBox>{error}</ErrorBox>
        {message ? <p className="note">{message}</p> : null}
        <div className="stats">
          {[
            [t.admin.pending, stats.pending],
            [t.admin.due, stats.due],
            [t.admin.oldest, Math.round(stats.oldestDueSeconds / 60)],
            [t.admin.failed, stats.failed],
            [t.admin.sent24h, stats.sentLast24h],
          ].map(([label, value]) => (
            <div key={String(label)} className="stat">
              <span className="small muted">{label}</span>
              <b>{value}</b>
            </div>
          ))}
        </div>
        <section className="section">
          <div className="row" style={{ alignItems: 'center' }}>
            <h2 style={{ flex: '1 1 auto' }}>{t.admin.failedList}</h2>
            {failed.length ? (
              <button
                type="button"
                className="btn btn--small"
                style={{ flex: '0 0 auto' }}
                onClick={() => void retry({ all: true })}
              >
                {t.admin.retryAll}
              </button>
            ) : null}
          </div>
          {failed.length === 0 ? (
            <p className="note">{t.admin.empty}</p>
          ) : (
            <ul className="list">
              {failed.map((f) => (
                <li key={f.id} className="list-row" style={{ cursor: 'default' }}>
                  <span className="grow">
                    <strong>{f.type}</strong>
                    <span className="small muted">
                      {fill(t.admin.attempts, { count: String(f.attempts) })} ·{' '}
                      {new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      }).format(new Date(f.lastAttemptAt))}
                    </span>
                    <span className="small">{f.lastError}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn--quiet btn--small"
                    onClick={() => void retry({ ids: [f.id] })}
                  >
                    {t.admin.retry}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
