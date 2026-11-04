'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { addDays, formatDay, formatPrice, todayIn, weekdayShort } from '@/lib/time';
import type { PublicAppointment, Slot } from '@/lib/types';
import { ErrorBox, LanguageSwitch, Spinner } from '../ui';
import { downloadIcs } from './ics';

type Mode = 'view' | 'move' | 'cancel';

/** The "manage my appointment" page behind the secret link from the email. */
export function ManageAppointment({ token }: { token: string }) {
  return <AppointmentManager endpoint={`/v1/public/appointments/${token}`} />;
}

/**
 * View, move and cancel one appointment as the client. `endpoint` is the API path of the
 * appointment (manage link or the "My visits" app); cancel and reschedule live under it.
 */
export function AppointmentManager<T extends PublicAppointment>({
  endpoint,
  title,
  top,
  extra,
}: {
  endpoint: string;
  /** Small caption above the salon name. */
  title?: string;
  /** Shown first in the page body (e.g. a link back to the list). */
  top?: ReactNode;
  /** Extra actions below the appointment (e.g. "book again"). */
  extra?: (appointment: T) => ReactNode;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [a, setA] = useState<T | null>(null);
  const [missing, setMissing] = useState(false);
  const [mode, setMode] = useState<Mode>('view');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [day, setDay] = useState('');
  /** The time the client tapped; moving waits for "Yes" (owner test T11). */
  const [pending, setPending] = useState<Slot | null>(null);

  const load = useCallback(async () => {
    try {
      setA(await api<T>(endpoint, { auth: false }));
    } catch {
      setMissing(true);
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (mode !== 'move' || !a) return;
    const from = todayIn(a.timezone);
    setSlots(null);
    setPending(null);
    api<{ slots: Slot[] }>(`/v1/public/locations/${a.salon.slug}/availability`, {
      auth: false,
      query: { serviceId: a.service.id, staffId: a.staff.id, from, to: addDays(from, 20) },
    })
      .then((res) => {
        setSlots(res.slots);
        setDay(res.slots[0]?.date ?? '');
      })
      .catch((err) => setError(errorText(t, err)));
  }, [mode, a, t]);

  async function run(action: () => Promise<T>, done: string) {
    setBusy(true);
    setError('');
    try {
      setA(await action());
      setMessage(done);
      setMode('view');
    } catch (err) {
      setError(errorText(t, err));
      if (err instanceof ApiError && err.code === 'TOO_LATE_TO_CHANGE') await load();
    } finally {
      setBusy(false);
    }
  }

  if (missing) {
    return (
      <div className="narrow stack">
        {top}
        <p className="note">{t.errors.NOT_FOUND}</p>
      </div>
    );
  }
  if (!a) return <Spinner />;

  const until = new Intl.DateTimeFormat(tag, {
    timeZone: a.timezone,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(a.changeableUntil));
  const days = Array.from(new Set((slots ?? []).map((s) => s.date)));

  return (
    <div className="booking">
      <header className="salon-head">
        <div className="salon-head-inner">
          <div className="top">
            <span className="small muted">{title ?? t.manage.title}</span>
            <LanguageSwitch />
          </div>
          <h1 className="salon-name">{a.salon.name}</h1>
          <span className="muted small">
            {a.salon.addressLine}, {a.salon.postalCode} {a.salon.city}
          </span>
        </div>
      </header>
      <main className="narrow stack">
        {top}
        {message ? (
          <p className="note" role="status">
            {message}
          </p>
        ) : null}
        <ErrorBox>{error}</ErrorBox>
        <div className="summary">
          <span className="big">
            {a.time} · {formatDay(a.date, tag, { short: true })}
          </span>
          <span>
            {a.service.name} · {a.staff.displayName} ·{' '}
            {formatPrice(a.service.priceGrosze, a.currency, tag)}
          </span>
          <span className="small">{t.appointment.status[a.status]}</span>
        </div>

        {a.status === 'confirmed' && mode === 'view' ? (
          <>
            <p className="small muted">
              {a.canChange ? fill(t.manage.changeUntil, { time: until }) : t.manage.tooLate}
            </p>
            <button
              type="button"
              className="btn btn--quiet btn--block"
              onClick={() => downloadIcs(a)}
            >
              {t.booking.addToCalendar}
            </button>
            {a.canChange ? (
              <>
                <button type="button" className="btn btn--block" onClick={() => setMode('move')}>
                  {t.manage.move}
                </button>
                <button
                  type="button"
                  className="btn btn--danger btn--block"
                  onClick={() => setMode('cancel')}
                >
                  {t.manage.cancel}
                </button>
              </>
            ) : a.salon.phone ? (
              <a className="btn btn--quiet btn--block" href={`tel:${a.salon.phone}`}>
                {a.salon.phone}
              </a>
            ) : null}
          </>
        ) : null}

        {mode === 'view' && extra ? extra(a) : null}

        {mode === 'cancel' ? (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  api<T>(`${endpoint}/cancel`, {
                    method: 'POST',
                    auth: false,
                    idempotencyKey: newIdempotencyKey(),
                    body: reason ? { reason } : {},
                  }),
                t.manage.cancelled,
              );
            }}
          >
            <label className="field">
              <span>{t.manage.cancelReason}</span>
              <textarea
                value={reason}
                maxLength={300}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <div className="row">
              <button type="button" className="btn btn--quiet" onClick={() => setMode('view')}>
                {t.manage.keep}
              </button>
              <button className="btn btn--danger" disabled={busy}>
                {t.manage.confirmCancel}
              </button>
            </div>
          </form>
        ) : null}

        {mode === 'move' ? (
          <section className="stack">
            {slots === null ? (
              <Spinner />
            ) : slots.length === 0 ? (
              <p className="note">{t.booking.noSlotsAtAll}</p>
            ) : (
              <>
                <div className="day-strip" role="group">
                  {days.map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={d === day}
                      aria-label={formatDay(d, tag)}
                      onClick={() => {
                        setDay(d);
                        setPending(null);
                      }}
                    >
                      <span>{weekdayShort(d, tag)}</span>
                      <b>{Number(d.slice(8))}</b>
                    </button>
                  ))}
                </div>
                <div className="times">
                  {slots
                    .filter((s) => s.date === day)
                    .map((s) => (
                      <button
                        key={s.start}
                        type="button"
                        disabled={busy}
                        aria-pressed={pending?.start === s.start}
                        onClick={() => setPending(s)}
                      >
                        {s.time}
                      </button>
                    ))}
                </div>
                {pending ? (
                  <div className="summary" role="alertdialog" aria-label={t.manage.move}>
                    <span>
                      {fill(t.manage.moveConfirm, {
                        time: pending.time,
                        day: formatDay(pending.date, tag, { short: true }),
                      })}
                    </span>
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn--quiet"
                        disabled={busy}
                        onClick={() => setPending(null)}
                      >
                        {t.manage.moveNo}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              api<T>(`${endpoint}/reschedule`, {
                                method: 'POST',
                                auth: false,
                                idempotencyKey: newIdempotencyKey(),
                                body: { start: pending.start },
                              }),
                            t.manage.moved,
                          )
                        }
                      >
                        {t.manage.moveYes}
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
            <button type="button" className="link-btn small" onClick={() => setMode('view')}>
              {t.common.back}
            </button>
          </section>
        ) : null}
      </main>
    </div>
  );
}
