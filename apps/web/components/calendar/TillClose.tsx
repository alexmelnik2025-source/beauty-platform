'use client';

import { useEffect, useId, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { TillClose as TillCloseView } from '@/lib/types';
import { parseTip } from './TipField';

/**
 * Task 232: "Zamknij kasę" in "Kasa dnia" — the owner or a manager types the cash counted in
 * the till at the end of the day; the app puts it beside what the visits of that day paid in
 * cash brought and shows what is missing or extra. Counting again replaces it. The server lets
 * only owners and managers see or save it, so the strip shows it only for the whole salon.
 */
export function TillClose({
  base,
  date,
  currency,
  refresh,
}: {
  base: string;
  date: string;
  currency: string;
  refresh: unknown;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const amountId = useId();
  const noteId = useId();
  const [view, setView] = useState<TillCloseView | null>(null);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<TillCloseView>(`${base}/reports/till-close`, { query: { date } })
      .then((v) => {
        if (alive) setView(v);
      })
      .catch(() => {
        if (alive) setView(null);
      });
    return () => {
      alive = false;
    };
  }, [base, date, refresh]);

  useEffect(() => setOpen(false), [date]);

  if (!view || view.date !== date) return null;
  const money = (hundredths: number) => formatPrice(hundredths, currency, tag);
  const parsed = amount.trim() === '' ? null : parseTip(amount);
  const close = view.close;

  const start = () => {
    setAmount(close ? (close.countedCashGrosze / 100).toFixed(2).replace('.', ',') : '');
    setNote(close?.note ?? '');
    setError(null);
    setOpen(true);
  };

  const save = async () => {
    if (parsed === null) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api<TillCloseView>(`${base}/reports/till-close`, {
        method: 'PUT',
        body: { date, countedCashGrosze: parsed, note: note.trim() || null },
      });
      setView(saved);
      setOpen(false);
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    return (
      <form
        className="till-close"
        data-testid="till-close-form"
        aria-label={t.calendar.tillClose}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <span className="small muted">
          {fill(t.calendar.tillExpected, { sum: money(view.expectedCashGrosze) })}
        </span>
        <label className="small" htmlFor={amountId}>
          {t.calendar.tillCounted} ({currency})
        </label>
        <input
          id={amountId}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          value={amount}
          aria-invalid={amount.trim() !== '' && parsed === null}
          onChange={(e) => setAmount(e.target.value)}
          style={{ maxWidth: 140 }}
          autoFocus
        />
        <label className="small" htmlFor={noteId}>
          {t.calendar.tillNote}
        </label>
        <input
          id={noteId}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          style={{ maxWidth: 260 }}
        />
        <button type="submit" className="btn btn--small" disabled={busy || parsed === null}>
          {t.calendar.tillSave}
        </button>
        <button type="button" className="btn btn--quiet btn--small" onClick={() => setOpen(false)}>
          {t.calendar.tillCancel}
        </button>
        {amount.trim() !== '' && parsed === null ? (
          <span className="small">{t.calendar.tillInvalid}</span>
        ) : null}
        {error ? (
          <span className="small" role="alert">
            {error}
          </span>
        ) : null}
      </form>
    );
  }

  if (!close) {
    return (
      <button
        type="button"
        className="btn btn--quiet btn--small"
        data-testid="till-close"
        onClick={start}
      >
        {t.calendar.tillClose}
      </button>
    );
  }

  const diff = close.differenceGrosze;
  const changed = close.expectedCashGrosze !== view.expectedCashGrosze;
  return (
    <span className="till-close" data-testid="till-closed">
      <strong>{t.calendar.tillClosed}:</strong>{' '}
      {fill(t.calendar.tillCountedOf, {
        counted: money(close.countedCashGrosze),
        expected: money(close.expectedCashGrosze),
      })}{' '}
      <span className={diff < 0 ? 'till-close__missing' : undefined} data-testid="till-diff">
        {diff === 0
          ? t.calendar.tillMatches
          : fill(diff < 0 ? t.calendar.tillMissing : t.calendar.tillSurplus, {
              sum: money(Math.abs(diff)),
            })}
      </span>
      {close.note ? <span className="muted"> · {close.note}</span> : null}
      <span className="muted small">
        {' '}
        ·{' '}
        {fill(t.calendar.tillClosedBy, {
          name: close.closedByName,
          time: new Date(close.closedAt).toLocaleTimeString(tag, {
            hour: '2-digit',
            minute: '2-digit',
          }),
        })}
      </span>
      {changed ? (
        <span className="small">
          {' '}
          {fill(t.calendar.tillChanged, { sum: money(view.expectedCashGrosze) })}
        </span>
      ) : null}{' '}
      <button type="button" className="btn btn--quiet btn--small" onClick={start}>
        {t.calendar.tillRecount}
      </button>
    </span>
  );
}
