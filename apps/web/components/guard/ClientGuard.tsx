'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { ErrorBox } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { GuardedClient } from '@/lib/types';

/**
 * Task 161c: "Ochrona przed odwołaniami" in the client card (owners and managers; the server
 * checks it too): whether the client is marked now and why, the cost of missed visits, the
 * history of cancellations, reschedules and no-shows, and "Zdejmij blokadę" with a note.
 * Nothing is shown while the protection is off and the client has no history.
 */
export function ClientGuard({ orgId, customerId }: { orgId: string; customerId: string }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const { location } = useSession();
  const url = `/v1/organizations/${orgId}/locations/${location.id}/cancellation-guard/clients/${customerId}`;
  const [guard, setGuard] = useState<GuardedClient | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const load = useCallback(async () => setGuard(await api<GuardedClient>(url)), [url]);

  useEffect(() => {
    load().catch((err) => setError(errorText(t, err)));
  }, [load, t]);

  async function release(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setGuard(
        await api<GuardedClient>(`${url}/release`, {
          method: 'POST',
          body: note.trim() ? { note: note.trim() } : {},
        }),
      );
      setAsking(false);
      setNote('');
      setInfo(t.guard.released);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  if (!guard) return error ? <ErrorBox>{error}</ErrorBox> : null;
  if (!guard.enabled && guard.history.length === 0) return null;

  const day = (iso: string) =>
    new Intl.DateTimeFormat(tag, {
      timeZone: location.timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(iso));
  const reasons = [
    guard.reasons.includes('changes') && fill(t.guard.reasonChanges, { n: String(guard.changes) }),
    guard.reasons.includes('late_cancel') &&
      fill(t.guard.reasonLate, { n: String(guard.lateCancellations) }),
    guard.reasons.includes('no_shows') && fill(t.guard.reasonNoShows, { n: String(guard.noShows) }),
  ].filter(Boolean);

  return (
    <section className="section stack" style={{ gap: 8 }} aria-label={t.guard.title}>
      <h3>{t.guard.title}</h3>
      <ErrorBox>{error}</ErrorBox>
      {info ? (
        <p className="small" role="status">
          {info}
        </p>
      ) : null}
      {guard.flagged ? (
        <div className="summary">
          <strong>{t.guard.cardMarked}</strong>
          <span className="small muted">{reasons.join(' · ')}</span>
          {guard.noShowAmountGrosze > 0 ? (
            <span className="small">
              {fill(t.guard.owes, {
                sum: formatPrice(guard.noShowAmountGrosze, guard.currency, tag),
              })}
            </span>
          ) : null}
          {asking ? (
            <form className="stack" style={{ gap: 8 }} onSubmit={(e) => void release(e)}>
              <p className="small">{t.guard.releaseAsk}</p>
              <label className="field">
                <span>{t.guard.note}</span>
                <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
              </label>
              <div className="row">
                <button className="btn btn--small" disabled={busy}>
                  {t.guard.releaseYes}
                </button>
                <button
                  type="button"
                  className="btn btn--small btn--quiet"
                  onClick={() => setAsking(false)}
                >
                  {t.guard.cancel}
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="btn btn--small btn--quiet"
              onClick={() => {
                setInfo('');
                setAsking(true);
              }}
            >
              {t.guard.release}
            </button>
          )}
        </div>
      ) : (
        <p className="small muted">{guard.enabled ? t.guard.cardNotMarked : t.guard.off}</p>
      )}
      {guard.history.length > 0 ? (
        <>
          <h4 className="small">{t.guard.historyTitle}</h4>
          <ul className="history">
            {guard.history.map((h, i) => (
              <li key={i}>
                <span>
                  {t.guard.historyType[h.type]}
                  {h.late ? <span className="muted"> · {t.guard.historyLate}</span> : null}
                  {h.note ? <span className="muted"> · {h.note}</span> : null}
                </span>
                <span className="muted">{day(h.at)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
