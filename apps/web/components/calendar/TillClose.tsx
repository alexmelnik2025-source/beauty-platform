'use client';

import { useEffect, useId, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { TillClose as TillCloseView } from '@/lib/types';
import { parseTip } from './TipField';

/**
 * Task 232: "Zamknij kasę" in "Kasa dnia" — the owner or a manager types the cash counted in
 * the till at the end of the day; the app puts it beside what should be there and shows what
 * is missing or extra. Counting again replaces it. The server lets only owners and managers
 * see or save it, so the strip shows it only for the whole salon.
 * Task 236: "Wpłata / wypłata" — cash put into or taken out of the till, with the reason; the
 * till should then hold the cash visits plus what was put in minus what was taken out.
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
  const [view, setView] = useState<TillCloseView | null>(null);

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

  if (!view || view.date !== date) return null;
  return (
    <>
      <TillMovements base={base} view={view} currency={currency} onChange={setView} />
      <TillCount base={base} view={view} currency={currency} onChange={setView} />
    </>
  );
}

/** One part of the day's till; `view` is the till of the day shown. */
interface TillPartProps {
  base: string;
  view: TillCloseView;
  currency: string;
  onChange: (view: TillCloseView) => void;
}

function useMoney(currency: string) {
  const { locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  return (hundredths: number) => formatPrice(hundredths, currency, tag);
}

/** "Powinno być w kasie: …" when cash was put in or taken out, else the cash visits. */
function ExpectedLine({ view, currency }: { view: TillCloseView; currency: string }) {
  const { t } = useI18n();
  const money = useMoney(currency);
  return (
    <span className="small muted">
      {view.movements.length > 0
        ? fill(t.calendar.tillShouldBe, {
            sum: money(view.expectedCashGrosze),
            visits: money(view.visitsCashGrosze),
            in: money(view.cashInGrosze),
            out: money(view.cashOutGrosze),
          })
        : fill(t.calendar.tillExpected, { sum: money(view.visitsCashGrosze) })}
    </span>
  );
}

/** Task 236: the day's cash put in / taken out, "Wpłata / wypłata" and removing a mistake. */
function TillMovements({ base, view, currency, onChange }: TillPartProps) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const money = useMoney(currency);
  const amountId = useId();
  const noteId = useId();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'in' | 'out'>('out');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const date = view.date;

  useEffect(() => setOpen(false), [date]);

  const parsed = amount.trim() === '' ? null : parseTip(amount);
  const valid = parsed !== null && parsed > 0 && note.trim() !== '';

  const run = async (call: () => Promise<TillCloseView>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await call());
      after?.();
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(
      () =>
        api<TillCloseView>(`${base}/reports/till-movements`, {
          method: 'POST',
          body: { date, kind, amountGrosze: parsed, note: note.trim() },
        }),
      () => setOpen(false),
    );

  const start = () => {
    setKind('out');
    setAmount('');
    setNote('');
    setError(null);
    setOpen(true);
  };

  const rowText = (m: TillCloseView['movements'][number]) =>
    `${fill(m.kind === 'in' ? t.calendar.tillMoveInRow : t.calendar.tillMoveOutRow, {
      sum: money(m.amountGrosze),
    })} · ${m.note}`;

  return (
    <>
      {view.movements.length > 0 ? (
        <ul className="till-moves" aria-label={t.calendar.tillMoves} data-testid="till-moves">
          {view.movements.map((m) => (
            <li key={m.id}>
              <span>{rowText(m)}</span>{' '}
              <span className="muted small">
                (
                {fill(t.calendar.tillClosedBy, {
                  name: m.createdByName,
                  time: new Date(m.createdAt).toLocaleTimeString(tag, {
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                })}
                )
              </span>{' '}
              <button
                type="button"
                className="btn btn--quiet btn--small"
                disabled={busy}
                aria-label={fill(t.calendar.tillMoveRemoveLabel, { what: rowText(m) })}
                onClick={() =>
                  void run(() =>
                    api<TillCloseView>(`${base}/reports/till-movements/${m.id}`, {
                      method: 'DELETE',
                    }),
                  )
                }
              >
                {t.calendar.tillMoveRemove}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <form
          className="till-close"
          data-testid="till-move-form"
          aria-label={t.calendar.tillMove}
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void save();
          }}
        >
          <fieldset className="till-moves__kind">
            <legend className="visually-hidden">{t.calendar.tillMove}</legend>
            {(['out', 'in'] as const).map((k) => (
              <label key={k} className="small">
                <input
                  type="radio"
                  name={`${noteId}-kind`}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />{' '}
                {k === 'in' ? t.calendar.tillMoveIn : t.calendar.tillMoveOut}
              </label>
            ))}
          </fieldset>
          <label className="small" htmlFor={amountId}>
            {t.calendar.tillMoveAmount} ({currency})
          </label>
          <input
            id={amountId}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={amount}
            aria-invalid={amount.trim() !== '' && (parsed === null || parsed === 0)}
            onChange={(e) => setAmount(e.target.value)}
            style={{ maxWidth: 120 }}
            autoFocus
          />
          <label className="small" htmlFor={noteId}>
            {t.calendar.tillMoveNote}
          </label>
          <input
            id={noteId}
            maxLength={200}
            placeholder={t.calendar.tillMoveHint}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          <button type="submit" className="btn btn--small" disabled={busy || !valid}>
            {t.calendar.tillSave}
          </button>
          <button
            type="button"
            className="btn btn--quiet btn--small"
            onClick={() => setOpen(false)}
          >
            {t.calendar.tillCancel}
          </button>
          {amount.trim() !== '' && (parsed === null || parsed === 0) ? (
            <span className="small">{t.calendar.tillInvalid}</span>
          ) : null}
        </form>
      ) : (
        <button
          type="button"
          className="btn btn--quiet btn--small"
          data-testid="till-move"
          onClick={start}
        >
          {t.calendar.tillMove}
        </button>
      )}
      {error ? (
        <span className="small" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

/** Task 232: "Zamknij kasę" / the closed till / "Policz ponownie". */
function TillCount({ base, view, currency, onChange }: TillPartProps) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const amountId = useId();
  const noteId = useId();
  const date = view.date;
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setOpen(false), [date]);

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
      onChange(saved);
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
        <ExpectedLine view={view} currency={currency} />
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
