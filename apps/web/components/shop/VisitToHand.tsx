'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { VisitReservations } from '@/lib/types';
import { FieldError } from '../ui';

/**
 * Task Q3 (screen D): "Do wydania klientowi" in the visit card — the products the client put aside
 * for this visit. "Wydaj i dolicz" hands one over: it becomes the usual sale at the visit (task
 * 394), so it shows under "Produkty" and in the till; it needs the visit marked "Przyszedł".
 * "Anuluj rezerwację" frees the pieces. Nothing is shown when nothing was put aside.
 * `onHanded` lets the card reload the sales list.
 */
export function VisitToHand({
  base,
  appointmentId,
  currency,
  canChange,
  completed,
  onHanded,
}: {
  base: string;
  appointmentId: string;
  currency: string;
  canChange: boolean;
  completed: boolean;
  onHanded: () => void;
}) {
  const { t, locale } = useI18n();
  const p = t.products;
  const tag = LOCALE_TAGS[locale];
  const [data, setData] = useState<VisitReservations | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Task 756 (owner's rule: errors where the action is): a refused "Wydaj i dolicz" or "Anuluj
   * rezerwację" is said under that product's row, not as a box above the whole list.
   */
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const url = `${base}/appointments/${appointmentId}/reservations`;
  const money = (n: number) => formatPrice(n, currency, tag);

  const load = useCallback(
    () =>
      api<VisitReservations>(url)
        .then(setData)
        .catch(() => setData(null)),
    [url],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function run(reservationId: string, action: 'hand-over' | 'cancel') {
    setBusy(true);
    setError(null);
    try {
      setData(
        await api<VisitReservations>(`${url}/${reservationId}/${action}`, { method: 'POST' }),
      );
      if (action === 'hand-over') onHanded();
    } catch (err) {
      setError({ id: reservationId, text: errorText(t, err) });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;
  const waiting = data.reservations.filter((r) => r.status === 'reserved');
  const handed = data.reservations.filter((r) => r.status === 'handed');
  if (waiting.length === 0 && handed.length === 0) return null;
  const rows = [...waiting, ...handed];
  // The row may be gone after the refresh (e.g. cancelled elsewhere): then under the list.
  const lostError = error && !rows.some((r) => r.id === error.id) ? error.text : undefined;

  return (
    <section
      className="wishes-card stack"
      style={{ gap: 6 }}
      aria-labelledby={`to-hand-${appointmentId}`}
      data-testid="visit-to-hand"
    >
      <strong id={`to-hand-${appointmentId}`}>🛍️ {p.toHandTitle}</strong>
      <ul className="commission-list" aria-label={p.toHandTitle}>
        {rows.map((r) => (
          <li key={r.id} className="commission-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span style={{ flex: '1 1 10rem' }}>
              {r.name}
              {r.quantity > 1 ? ` × ${r.quantity}` : null}
            </span>
            <span>{money(r.totalGrosze)}</span>
            {r.status === 'handed' ? (
              <span className="small muted">✓ {p.toHandHanded}</span>
            ) : canChange ? (
              <span className="row" style={{ gap: 8 }}>
                {completed ? (
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy}
                    aria-label={`${p.toHandGive} — ${r.name}`}
                    aria-describedby={error?.id === r.id ? `to-hand-${r.id}-error` : undefined}
                    onClick={() => void run(r.id, 'hand-over')}
                  >
                    {p.toHandGive}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="link-btn small"
                  disabled={busy}
                  aria-label={`${p.toHandCancel} — ${r.name}`}
                  aria-describedby={error?.id === r.id ? `to-hand-${r.id}-error` : undefined}
                  onClick={() => void run(r.id, 'cancel')}
                >
                  {p.toHandCancel}
                </button>
              </span>
            ) : null}
            {error?.id === r.id ? (
              <div style={{ flexBasis: '100%' }}>
                <FieldError id={`to-hand-${r.id}-error`} text={error.text} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <FieldError id={`to-hand-${appointmentId}-error`} text={lostError} />
      {data.toHandGrosze > 0 ? (
        <span className="small">{fill(p.toHandTotal, { amount: money(data.toHandGrosze) })}</span>
      ) : null}
      {waiting.length > 0 && canChange && !completed ? (
        <span className="small muted">{p.toHandAfterCame}</span>
      ) : null}
    </section>
  );
}
