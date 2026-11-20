'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';
import type { Location } from '@/lib/types';
import { useSession } from '../Session';
import { ErrorBox } from '../ui';

/**
 * Task Q3: how many days a product put aside for a visit waits for the client after the visit
 * ("nie odebrał za N dni — rezerwacja wygasa"). The salon's setting (`shopReservationDays`, 1–90,
 * 14 by default); only the owner and the manager may change the salon's settings, so the
 * specialist sees the number without the field. One small card at the bottom of "Mój sklep".
 */
export function ReservationDays({ base }: { base: string }) {
  const { t } = useI18n();
  const canEdit = useSession().role !== 'staff';
  const s = t.shop;
  const [loc, setLoc] = useState<Location | null>(null);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<Location>(base)
      .then((l) => {
        setLoc(l);
        setDays(String(l.shopReservationDays));
      })
      .catch((e: unknown) => setError(errorText(t, e)));
  }, [base, t]);

  if (!loc) return error ? <ErrorBox>{error}</ErrorBox> : null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const n = Number(days);
    if (!/^\d{1,2}$/.test(days.trim()) || n < 1 || n > 90) {
      setError(s.reservationDaysInvalid);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = await api<Location>(base, {
        method: 'PATCH',
        body: { version: loc.version, shopReservationDays: n },
      });
      setLoc(next);
      setDays(String(next.shopReservationDays));
      setSaved(true);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card stack"
      onSubmit={(e) => void save(e)}
      aria-labelledby="shop-reservation-days-title"
      data-testid="shop-reservation-days"
    >
      <h2 id="shop-reservation-days-title" className="h3">
        {s.reservationDaysTitle}
      </h2>
      {canEdit ? (
        <>
          <p className="small muted">{s.reservationDaysHint}</p>
          {error ? <ErrorBox>{error}</ErrorBox> : null}
          <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="field">
              <span>{s.reservationDays}</span>
              <input
                value={days}
                inputMode="numeric"
                maxLength={2}
                required
                onChange={(e) => {
                  setDays(e.target.value);
                  setSaved(false);
                }}
              />
            </label>
            <button type="submit" className="btn" disabled={busy}>
              {t.common.save}
            </button>
          </div>
          {saved ? (
            <p className="note" role="status">
              {t.actions.saved}
            </p>
          ) : null}
        </>
      ) : (
        <p className="small muted">
          {fill(s.reservationDaysNow, { n: String(loc.shopReservationDays) })}
        </p>
      )}
    </form>
  );
}
