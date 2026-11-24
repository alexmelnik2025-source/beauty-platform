'use client';

import { useCallback, useEffect, useState } from 'react';
import { ErrorBox, FieldError, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import type { FailedEmail as Failed, OutboxStats as Stats } from '@/lib/types';

/** Platform administrators only: health of the email queue and resending failed emails. */
export default function OutboxPage() {
  const { t, locale } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState<Failed[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  /**
   * Task 841 (owner's rule: errors where the action is): a refused "Wyślij wszystkie ponownie" or
   * "Wyślij ponownie" is said right under the pressed button, not as a box at the top of the page.
   * The box stays only for a page that failed to load. `at` is 'all' or the email's id.
   */
  const [retryError, setRetryError] = useState<{ at: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function retry(body: { all: true } | { ids: string[] }, at: string) {
    if (busy) return;
    setBusy(true);
    setRetryError(null);
    setMessage('');
    try {
      const res = await api<{ requeued: number }>('/v1/admin/outbox/retry', {
        method: 'POST',
        body,
      });
      setMessage(fill(t.admin.requeued, { count: String(res.requeued) }));
      await load();
    } catch (err) {
      setRetryError({ at, text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  }

  const errorAt = (at: string) => (retryError?.at === at ? retryError.text : undefined);

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
                disabled={busy}
                aria-describedby={errorAt('all') ? 'outbox-retry-all-error' : undefined}
                onClick={() => void retry({ all: true }, 'all')}
              >
                {t.admin.retryAll}
              </button>
            ) : null}
          </div>
          <FieldError id="outbox-retry-all-error" text={errorAt('all')} />
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
                  <span className="stack" style={{ gap: 4, flex: '0 0 auto' }}>
                    <button
                      type="button"
                      className="btn btn--quiet btn--small"
                      disabled={busy}
                      aria-describedby={errorAt(f.id) ? `outbox-retry-error-${f.id}` : undefined}
                      onClick={() => void retry({ ids: [f.id] }, f.id)}
                    >
                      {t.admin.retry}
                    </button>
                    <FieldError id={`outbox-retry-error-${f.id}`} text={errorAt(f.id)} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
