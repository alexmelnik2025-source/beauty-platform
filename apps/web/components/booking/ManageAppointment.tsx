'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { addDays, formatDay, formatPrice, todayIn, weekdayShort } from '@/lib/time';
import type { PublicAppointment, Slot, VisitPhotoList } from '@/lib/types';
import { ErrorBox, FieldError, LanguageSwitch, Spinner } from '../ui';
import { downloadIcs } from './ics';
import { VisitReviewForm } from '../reviews/VisitReviewForm';
import { VisitProductsByLink } from './VisitProductsByLink';
import { UsedProductsByLink } from './UsedProductsByLink';
import { CancelledVisitProducts } from './CancelledVisitProducts';
import { asksWishes, WishesPicker } from '../wishes/WishesPicker';
import type { VisitWishes } from '../wishes/wishes';
import { directionsLink } from './SalonProfile';
import { ShareVisit } from './ShareVisit';

type Mode = 'view' | 'move' | 'cancel';

/** The "manage my appointment" page behind the secret link from the email. */
export function ManageAppointment({ token }: { token: string }) {
  const endpoint = `/v1/public/appointments/${token}`;
  // Task 20: the server's .ics keeps the same event when the visit moves (UID + SEQUENCE).
  return (
    <AppointmentManager
      endpoint={endpoint}
      calendarHref={`${endpoint}/calendar.ics`}
      usedProducts
    />
  );
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
  usedProducts = false,
}: {
  endpoint: string;
  /** Task Q3 (screen C): "Na wizycie użyto" under the review, by the visit link. */
  usedProducts?: boolean;
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
  /**
   * Task 833 (owner's rule: errors where the action is): a refused "Tak, przenieś" is said under
   * that button in the proposal (the proposed time stays), a refused "Tak, odwołaj" under that
   * button (the reason stays) — not as a box at the top of the panel or above the buttons.
   */
  const [actionError, setActionError] = useState<{ at: 'move' | 'cancel'; text: string } | null>(
    null,
  );
  const errorAt = (at: 'move' | 'cancel') => (actionError?.at === at ? actionError.text : '');
  const [busy, setBusy] = useState(false);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [day, setDay] = useState('');
  /** The time the client tapped; moving waits for "Yes" (owner test T11). */
  const [pending, setPending] = useState<Slot | null>(null);
  /** Task 720: bumped to ask for the free times again (the chosen one was just taken). */
  const [slotsAsked, setSlotsAsked] = useState(0);

  /**
   * Task 720 (owner's rule: errors at the field): a panel opens and closes with a clean error
   * line, so the answer to "Zmień termin" / "Odwołaj wizytę" is said in that panel, by its
   * buttons, and the answer to the visit's page stays above the visit.
   */
  const openMode = useCallback((next: Mode) => {
    setError('');
    setActionError(null);
    setMode(next);
  }, []);

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
        // Asked again after a taken time: the client stays on the day they were looking at.
        setDay((was) => (res.slots.some((x) => x.date === was) ? was : (res.slots[0]?.date ?? '')));
      })
      .catch((err) => setError(errorText(t, err)));
  }, [mode, a, t, slotsAsked]);

  // "Zmień termin" and "Odwołaj wizytę" give way to their panel: keyboard focus goes into the
  // panel, and back to the button when the client returns (or to the visit summary when the
  // button is gone — the visit was cancelled).
  const panelRef = useRef<HTMLElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const lastMode = useRef<Mode>('view');
  useEffect(() => {
    const was = lastMode.current;
    lastMode.current = mode;
    if (mode !== 'view') {
      panelRef.current?.focus();
      return;
    }
    if (was === 'view') return;
    const opener = (was === 'move' ? moveRef : cancelRef).current;
    if (opener) opener.focus();
    else summaryRef.current?.focus();
  }, [mode]);

  async function run(action: () => Promise<T>, done: string, at: 'move' | 'cancel') {
    setBusy(true);
    setError('');
    setActionError(null);
    try {
      setA(await action());
      setMessage(done);
      setMode('view');
    } catch (err) {
      const text = errorText(t, err);
      const tooLate = err instanceof ApiError && err.code === 'TOO_LATE_TO_CHANGE';
      const taken = err instanceof ApiError && err.code === 'SLOT_TAKEN';
      // The visit's page and the free times keep their answer above them; any other refusal is
      // said under the pressed button.
      if (tooLate || taken) setError(text);
      else setActionError({ at, text });
      if (tooLate) {
        // Nothing can be changed any more: back to the visit, where the error stands above it
        // with "Zmiana tylko telefonicznie" and the salon's phone.
        await load();
        setMode('view');
      } else if (taken) {
        // Task 720: the time went to someone else meanwhile — the proposal closes and the free
        // times are asked again, so the client is not left tapping a time that is gone.
        setPending(null);
        setSlotsAsked((n) => n + 1);
      }
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
        {mode === 'view' ? <ErrorBox>{error}</ErrorBox> : null}
        <div className="summary" ref={summaryRef} tabIndex={-1}>
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
            <a
              className="btn btn--quiet btn--block"
              href={directionsLink(a.salon)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t.booking.directions}
            </a>
            <ShareVisit visit={a} />
            {a.canChange ? (
              <>
                <button
                  type="button"
                  className="btn btn--block"
                  ref={moveRef}
                  onClick={() => openMode('move')}
                >
                  {t.manage.move}
                </button>
                <button
                  type="button"
                  className="btn btn--danger btn--block"
                  ref={cancelRef}
                  onClick={() => openMode('cancel')}
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

        {/* Task Q3: products put aside for the visit, picked up and paid at the salon. */}
        {mode === 'view' && a.status !== 'cancelled' ? (
          <VisitProductsByLink key={`products-${a.id}`} endpoint={endpoint} />
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

        {/* Task Q3: a cancelled visit had products waiting — book a new time, they come along. */}
        {mode === 'view' && a.status === 'cancelled' ? (
          <CancelledVisitProducts key={`move-${a.id}`} endpoint={endpoint} visit={a} />
        ) : null}

        {/* Task Q3 (screen C): what the specialist used — put aside for the next visit. */}
        {mode === 'view' && usedProducts && a.status === 'completed' ? (
          <UsedProductsByLink key={`used-${a.id}`} endpoint={endpoint} slug={a.salon.slug} />
        ) : null}

        {mode === 'view' && extra ? extra(a, setA) : null}

        {mode === 'cancel' ? (
          <form
            className="form"
            ref={(el) => {
              panelRef.current = el;
            }}
            tabIndex={-1}
            aria-label={t.manage.cancel}
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
                'cancel',
              );
            }}
          >
            <label className="field">
              <span>{t.manage.cancelReason}</span>
              <textarea
                value={reason}
                maxLength={300}
                onChange={(e) => {
                  setReason(e.target.value);
                  setActionError(null);
                }}
              />
            </label>
            <ErrorBox>{error}</ErrorBox>
            <div className="row">
              <button type="button" className="btn btn--quiet" onClick={() => openMode('view')}>
                {t.manage.keep}
              </button>
              <button
                className="btn btn--danger"
                disabled={busy}
                aria-describedby={errorAt('cancel') ? 'manage-cancel-error' : undefined}
              >
                {t.manage.confirmCancel}
              </button>
            </div>
            <FieldError id="manage-cancel-error" text={errorAt('cancel')} />
          </form>
        ) : null}

        {mode === 'move' ? (
          <section className="stack" ref={panelRef} tabIndex={-1} aria-label={t.manage.move}>
            <ErrorBox>{error}</ErrorBox>
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
                        setActionError(null);
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
                        onClick={() => {
                          setPending(s);
                          setActionError(null);
                        }}
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
                        onClick={() => {
                          setPending(null);
                          setActionError(null);
                        }}
                      >
                        {t.manage.moveNo}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        aria-describedby={errorAt('move') ? 'manage-move-error' : undefined}
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
                            'move',
                          )
                        }
                      >
                        {t.manage.moveYes}
                      </button>
                    </div>
                    <FieldError id="manage-move-error" text={errorAt('move')} />
                  </div>
                ) : null}
              </>
            )}
            <button type="button" className="link-btn small" onClick={() => openMode('view')}>
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
  /**
   * Task 775 (owner's rule: errors where the action is): a refused "Zapisz życzenia" is said
   * under that button, not as a box above the questions; the answers stay as chosen.
   */
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
      <WishesPicker
        questions={appointment.wishQuestions}
        value={value}
        onChange={(next) => {
          setValue(next);
          setError('');
        }}
      />
      <button
        className="btn btn--quiet btn--block"
        disabled={busy}
        aria-describedby={error ? 'wishes-save-error' : undefined}
      >
        {t.wishStep.save}
      </button>
      <FieldError id="wishes-save-error" text={error} />
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
  /**
   * Task 776 (owner's rule: errors where the action is): a refused "Usuń" is said under that
   * photo, not as a box above all of them.
   */
  const [error, setError] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    api<VisitPhotoList>(`${endpoint}/photos`, { auth: false })
      .then(setPhotos)
      .catch(() => setPhotos(null));
  }, [endpoint]);

  if (!photos || photos.items.length === 0) return null;
  const alt = (i: number) => w.photoAlt.replace('{n}', String(i + 1));

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`${endpoint}/photos/${id}`, { method: 'DELETE', auth: false });
      setPhotos((list) =>
        list ? { ...list, items: list.items.filter((p) => p.id !== id) } : list,
      );
    } catch (err) {
      setError({ id, text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section" aria-labelledby="visit-photos-title">
      <h2 id="visit-photos-title">📷 {w.photosQ}</h2>
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
                aria-describedby={error?.id === p.id ? `visit-photo-${p.id}-error` : undefined}
                onClick={() => void remove(p.id)}
              >
                {w.photosRemove}
              </button>
            ) : null}
            <FieldError
              id={`visit-photo-${p.id}-error`}
              text={error?.id === p.id ? error.text : undefined}
            />
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
