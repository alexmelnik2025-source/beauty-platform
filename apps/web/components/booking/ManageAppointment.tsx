'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { addDays, formatDay, formatPrice, todayIn, weekdayShort } from '@/lib/time';
import type { PublicAppointment, Slot, VisitPhotoList } from '@/lib/types';
import { ErrorBox, LanguageSwitch, Spinner } from '../ui';
import { downloadIcs } from './ics';
import { VisitReviewForm } from '../reviews/VisitReviewForm';
import { asksWishes, WishesPicker } from '../wishes/WishesPicker';
import type { VisitWishes } from '../wishes/wishes';

type Mode = 'view' | 'move' | 'cancel';

/** The "manage my appointment" page behind the secret link from the email. */
export function ManageAppointment({ token }: { token: string }) {
  const endpoint = `/v1/public/appointments/${token}`;
  // Task 20: the server's .ics keeps the same event when the visit moves (UID + SEQUENCE).
  return <AppointmentManager endpoint={endpoint} calendarHref={`${endpoint}/calendar.ics`} />;
}

/**
 * View, move and cancel one appointment as the client. `endpoint` is the API path of the
 * appointment (manage link or the "My visits" app); cancel and reschedule live under it.
 */
export function AppointmentManager<T extends PublicAppointment>({
  endpoint,
  calendarHref,
  title,
  top,
  extra,
}: {
  endpoint: string;
  /** The visit as an .ics file from the server; without it the file is made in the browser. */
  calendarHref?: string;
  /** Small caption above the salon name. */
  title?: string;
  /** Shown first in the page body (e.g. a link back to the list). */
  top?: ReactNode;
  /** Extra actions below the appointment (e.g. "book again"); `update` shows a changed appointment. */
  extra?: (appointment: T, update: (changed: T) => void) => ReactNode;
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
        {a.awaitingApproval ? (
          <p className="small">
            <strong>⏳ {t.manage.awaitingApproval}</strong>
          </p>
        ) : null}

        {a.status === 'confirmed' && mode === 'view' ? (
          <>
            <p className="small muted">
              {a.canChange ? fill(t.manage.changeUntil, { time: until }) : t.manage.tooLate}
            </p>
            {calendarHref ? (
              <a className="btn btn--quiet btn--block" href={calendarHref} download>
                {t.booking.addToCalendar}
              </a>
            ) : (
              <button
                type="button"
                className="btn btn--quiet btn--block"
                onClick={() => downloadIcs(a)}
              >
                {t.booking.addToCalendar}
              </button>
            )}
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

        {mode === 'view' ? (
          <VisitPhotosByLink
            key={`photos-${a.id}`}
            endpoint={endpoint}
            canRemove={a.canChangeWishes}
          />
        ) : null}

        {mode === 'view' && a.canChangeWishes && asksWishes(a.wishQuestions) ? (
          <WishesEditor
            key={a.id}
            endpoint={endpoint}
            appointment={a}
            onSaved={(changed) => {
              setA(changed);
              setMessage(t.wishStep.saved);
            }}
          />
        ) : null}

        {mode === 'view' && a.status !== 'cancelled' ? (
          <VisitReviewForm
            key={`review-${a.id}`}
            endpoint={`${endpoint}/review`}
            staffName={a.staff.displayName}
          />
        ) : null}

        {mode === 'view' && extra ? extra(a, setA) : null}

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

/** Task 80: the client changes the wishes for the visit until it starts. */
function WishesEditor<T extends PublicAppointment>({
  endpoint,
  appointment,
  onSaved,
}: {
  endpoint: string;
  appointment: T;
  onSaved: (changed: T) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState<VisitWishes>(appointment.wishes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      className="form section"
      aria-labelledby="wishes-edit-title"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        api<T>(`${endpoint}/wishes`, {
          method: 'PUT',
          auth: false,
          body: { mood: value.mood, drink: value.drink, note: value.note ?? '' },
        })
          .then(onSaved)
          .catch((err) => setError(errorText(t, err)))
          .finally(() => setBusy(false));
      }}
    >
      <h2 id="wishes-edit-title">{t.wishStep.title}</h2>
      <ErrorBox>{error}</ErrorBox>
      <WishesPicker questions={appointment.wishQuestions} value={value} onChange={setValue} />
      <button className="btn btn--quiet btn--block" disabled={busy}>
        {t.wishStep.save}
      </button>
    </form>
  );
}

/**
 * Task 80b/80f: the example photos the client added when booking ("Pokaż, co chcesz"):
 * seen by the visit link, removable until the visit starts; deleted 90 days after it.
 */
function VisitPhotosByLink({ endpoint, canRemove }: { endpoint: string; canRemove: boolean }) {
  const { t, locale } = useI18n();
  const w = t.wishStep;
  const [photos, setPhotos] = useState<VisitPhotoList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<VisitPhotoList>(`${endpoint}/photos`, { auth: false })
      .then(setPhotos)
      .catch(() => setPhotos(null));
  }, [endpoint]);

  if (!photos || photos.items.length === 0) return null;
  const alt = (i: number) => w.photoAlt.replace('{n}', String(i + 1));

  async function remove(id: string) {
    setBusy(true);
    setError('');
    try {
      await api(`${endpoint}/photos/${id}`, { method: 'DELETE', auth: false });
      setPhotos((list) =>
        list ? { ...list, items: list.items.filter((p) => p.id !== id) } : list,
      );
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section" aria-labelledby="visit-photos-title">
      <h2 id="visit-photos-title">📷 {w.photosQ}</h2>
      <ErrorBox>{error}</ErrorBox>
      <ul className="wish-photos">
        {photos.items.map((p, i) => (
          <li key={p.id} className="wish-photos__item">
            <img src={p.url} alt={alt(i)} />
            {canRemove ? (
              <button
                type="button"
                className="link-btn small"
                disabled={busy}
                aria-label={`${w.photosRemove}: ${alt(i)}`}
                onClick={() => void remove(p.id)}
              >
                {w.photosRemove}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {photos.deleteAfter ? (
        <p className="small muted">
          {w.photosKeptUntil.replace(
            '{date}',
            new Intl.DateTimeFormat(LOCALE_TAGS[locale], { dateStyle: 'long' }).format(
              new Date(photos.deleteAfter),
            ),
          )}
        </p>
      ) : null}
    </section>
  );
}
