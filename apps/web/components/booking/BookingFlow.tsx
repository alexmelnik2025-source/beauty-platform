'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { addDays, clockToMinutes, formatDay, formatPrice, todayIn, weekdayShort } from '@/lib/time';
import type { Hold, PublicAppointment, PublicLocation, Slot } from '@/lib/types';
import { normalizePhone } from '../calendar/NewItemSheet';
import { LanguageBadges } from '../Languages';
import { ErrorBox, LanguageSwitch, Spinner } from '../ui';
import { downloadIcs } from './ics';

type Step = 'service' | 'staff' | 'time' | 'details' | 'code' | 'done';
const DAYS_SHOWN = 21;
/** Name, phone and email kept on this device when the client ticks "remember me". */
const REMEMBER_KEY = 'bp_booking_contact';

interface RememberedContact {
  name: string;
  phone: string;
  email: string;
}

function loadRemembered(): RememberedContact | null {
  try {
    const raw = window.localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RememberedContact>;
    if (typeof value.name !== 'string' || typeof value.email !== 'string') return null;
    return {
      name: value.name,
      phone: typeof value.phone === 'string' ? value.phone : '',
      email: value.email,
    };
  } catch {
    return null;
  }
}

function saveRemembered(value: RememberedContact | null): void {
  try {
    if (value) window.localStorage.setItem(REMEMBER_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // Private mode or blocked storage: the form simply is not prefilled next time.
  }
}

export function BookingFlow({ slug }: { slug: string }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];

  const [salon, setSalon] = useState<PublicLocation | null>(null);
  const [closed, setClosed] = useState(false);
  const [step, setStep] = useState<Step>('service');
  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState<string | undefined>(undefined);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [day, setDay] = useState('');
  const [hold, setHold] = useState<Hold | null>(null);
  const [contact, setContact] = useState({
    name: '',
    phone: '+48 ',
    email: '',
    acceptTerms: false,
    marketingConsent: false,
  });
  const [remember, setRemember] = useState(false);
  const [remembered, setRemembered] = useState(false);
  const [code, setCode] = useState('');
  const [result, setResult] = useState<{
    appointment: PublicAppointment;
    manageToken: string;
    signedIn: boolean;
  }>();

  // Details remembered on this device after an earlier booking.
  useEffect(() => {
    const saved = loadRemembered();
    if (!saved) return;
    setContact((c) => ({ ...c, ...saved, phone: saved.phone || c.phone }));
    setRemember(true);
    setRemembered(true);
  }, []);

  function forgetMe() {
    saveRemembered(null);
    setRemember(false);
    setRemembered(false);
    setContact((c) => ({ ...c, name: '', phone: '+48 ', email: '' }));
  }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PublicLocation>(`/v1/public/locations/${slug}`, { auth: false })
      .then((loaded) => {
        setSalon(loaded);
        // "Book again" from the client app: ?service=…&staff=… skips straight to the times.
        const params = new URLSearchParams(window.location.search);
        const preService = loaded.services.find((s) => s.id === params.get('service'));
        if (!preService) return;
        setServiceId(preService.id);
        const preStaff = loaded.staff.find(
          (s) => s.id === params.get('staff') && s.serviceIds.includes(preService.id),
        );
        setStaffId(preStaff?.id);
        setStep(preStaff ? 'time' : 'staff');
      })
      .catch(() => setClosed(true));
  }, [slug]);

  const service = salon?.services.find((s) => s.id === serviceId);
  const tz = salon?.timezone ?? 'Europe/Warsaw';

  const loadSlots = useCallback(async () => {
    if (!serviceId) return;
    setSlots(null);
    const from = todayIn(tz);
    const res = await api<{ slots: Slot[] }>(`/v1/public/locations/${slug}/availability`, {
      auth: false,
      query: { serviceId, staffId, from, to: addDays(from, DAYS_SHOWN - 1) },
    });
    setSlots(res.slots);
    setDay((current) =>
      current && res.slots.some((s) => s.date === current) ? current : (res.slots[0]?.date ?? ''),
    );
  }, [serviceId, staffId, slug, tz]);

  useEffect(() => {
    if (step === 'time') void loadSlots().catch((err) => setError(errorText(t, err)));
  }, [step, loadSlots, t]);

  const days = useMemo(() => {
    const from = todayIn(tz);
    return Array.from({ length: DAYS_SHOWN }, (_, i) => addDays(from, i));
  }, [tz]);

  async function pickTime(slot: Slot) {
    setBusy(true);
    setError('');
    try {
      const created = await api<Hold>(`/v1/public/locations/${slug}/holds`, {
        method: 'POST',
        auth: false,
        idempotencyKey: newIdempotencyKey(),
        body: {
          serviceId,
          staffId,
          start: slot.start,
          ...(hold ? { releaseHoldToken: hold.holdToken } : {}),
        },
      });
      setHold(created);
      setStep('details');
    } catch (err) {
      setError(errorText(t, err));
      if (err instanceof ApiError && err.code === 'SLOT_TAKEN') await loadSlots();
    } finally {
      setBusy(false);
    }
  }

  function backToTime(err: unknown) {
    setError(errorText(t, err));
    setHold(null);
    setStep('time');
  }

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    if (!hold) return;
    setBusy(true);
    setError('');
    try {
      await api(`/v1/public/holds/${hold.holdId}/code`, {
        method: 'POST',
        auth: false,
        body: {
          holdToken: hold.holdToken,
          name: contact.name,
          phone: normalizePhone(contact.phone),
          email: contact.email,
          locale,
          acceptTerms: contact.acceptTerms,
          marketingConsent: contact.marketingConsent,
        },
      });
      setStep('code');
    } catch (err) {
      if (err instanceof ApiError && ['HOLD_EXPIRED', 'NOT_FOUND'].includes(err.code)) {
        backToTime(err);
      } else {
        setError(errorText(t, err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!hold) return;
    setBusy(true);
    setError('');
    try {
      const done = await api<{
        appointment: PublicAppointment;
        manageToken: string;
        signedIn: boolean;
      }>(`/v1/public/holds/${hold.holdId}/confirm`, {
        method: 'POST',
        auth: false,
        idempotencyKey: `confirm-${hold.holdId}-${code}`,
        // "Remember me" also signs in to "My visits" on this device: the visit is already there.
        body: { holdToken: hold.holdToken, code, signIn: remember },
      });
      saveRemembered(
        remember
          ? { name: contact.name, phone: normalizePhone(contact.phone), email: contact.email }
          : null,
      );
      setResult(done);
      setStep('done');
    } catch (err) {
      if (
        err instanceof ApiError &&
        ['HOLD_EXPIRED', 'TOO_MANY_ATTEMPTS', 'TOO_MANY_CODES'].includes(err.code)
      ) {
        backToTime(err);
      } else {
        setError(errorText(t, err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (closed) {
    return (
      <div className="narrow">
        <p className="note">{t.booking.salonClosed}</p>
      </div>
    );
  }
  if (!salon) return <Spinner />;

  const stepIndex = { service: 0, staff: 1, time: 2, details: 3, code: 3, done: 4 }[step];
  const stepNames = [
    t.booking.stepService,
    t.booking.stepStaff,
    t.booking.stepTime,
    t.booking.stepDetails,
  ];
  const staffForService = salon.staff.filter((s) => s.serviceIds.includes(serviceId));
  const daySlots = (slots ?? []).filter((s) => s.date === day);
  const daysWithSlots = new Set((slots ?? []).map((s) => s.date));
  const groups = [
    { label: t.booking.morning, slots: daySlots.filter((s) => clockToMinutes(s.time) < 12 * 60) },
    {
      label: t.booking.afternoon,
      slots: daySlots.filter((s) => {
        const m = clockToMinutes(s.time);
        return m >= 12 * 60 && m < 17 * 60;
      }),
    },
    { label: t.booking.evening, slots: daySlots.filter((s) => clockToMinutes(s.time) >= 17 * 60) },
  ].filter((g) => g.slots.length > 0);

  return (
    <div className="booking">
      <header className="salon-head">
        <div className="salon-head-inner">
          <div className="top">
            <span className="small muted">{t.booking.bookVisit}</span>
            <LanguageSwitch />
          </div>
          <h1 className="salon-name">{salon.name}</h1>
          <span className="muted small">
            {salon.addressLine}, {salon.postalCode} {salon.city}
          </span>
          <LanguageBadges codes={salon.languages ?? []} label={t.languages.speaks} />
        </div>
      </header>

      <main className="narrow stack">
        {step !== 'done' ? (
          <ol className="progress" aria-label={t.booking.bookVisit}>
            {stepNames.map((name, i) => (
              <li
                key={name}
                data-state={i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'next'}
                aria-current={i === stepIndex ? 'step' : undefined}
              >
                {name}
              </li>
            ))}
          </ol>
        ) : null}

        <ErrorBox>{error}</ErrorBox>

        {step === 'service' ? (
          <ServiceList
            salon={salon}
            onPick={(id) => {
              setServiceId(id);
              setStaffId(undefined);
              setError('');
              setStep('staff');
            }}
          />
        ) : null}

        {step === 'staff' && service ? (
          <section className="stack">
            <h2>{service.name}</h2>
            <ul className="choice-list">
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setStaffId(undefined);
                    setStep('time');
                  }}
                >
                  <span className="c-name">{t.booking.anyStaff}</span>
                  <span className="c-meta">{t.booking.anyStaffHint}</span>
                </button>
              </li>
              {staffForService.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setStaffId(s.id);
                      setStep('time');
                    }}
                  >
                    <span className="c-name">{s.displayName}</span>
                    {s.bio ? <span className="c-meta">{s.bio}</span> : null}
                    <LanguageBadges codes={s.languages ?? []} />
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="link-btn small" onClick={() => setStep('service')}>
              {t.common.back}
            </button>
          </section>
        ) : null}

        {step === 'time' && service ? (
          <section className="stack">
            <h2>{service.name}</h2>
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
                      disabled={!daysWithSlots.has(d)}
                      onClick={() => setDay(d)}
                      aria-label={formatDay(d, tag)}
                    >
                      <span>{weekdayShort(d, tag)}</span>
                      <b>{Number(d.slice(8))}</b>
                    </button>
                  ))}
                </div>
                <p className="muted small">{day ? formatDay(day, tag) : ''}</p>
                {groups.length === 0 ? (
                  <p className="note">{t.booking.noSlotsDay}</p>
                ) : (
                  groups.map((g) => (
                    <div key={g.label} className="stack" style={{ gap: 8 }}>
                      <h3 className="muted small">{g.label}</h3>
                      <div className="times">
                        {g.slots.map((s) => (
                          <button
                            key={s.start}
                            type="button"
                            disabled={busy}
                            onClick={() => void pickTime(s)}
                          >
                            {s.time}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </>
            )}
            <button type="button" className="link-btn small" onClick={() => setStep('staff')}>
              {t.common.back}
            </button>
          </section>
        ) : null}

        {(step === 'details' || step === 'code') && hold ? (
          <HoldSummary
            hold={hold}
            onExpired={() => backToTime(new ApiError(410, 'HOLD_EXPIRED', ''))}
          >
            <button
              type="button"
              className="link-btn small"
              onClick={() => {
                setStep('time');
              }}
            >
              {t.booking.changeTime}
            </button>
          </HoldSummary>
        ) : null}

        {step === 'details' && hold ? (
          <form className="form" onSubmit={sendCode}>
            <h2>{t.booking.yourDetails}</h2>
            {remembered ? (
              <button type="button" className="link-btn small" onClick={forgetMe}>
                {t.booking.notMe}
              </button>
            ) : null}
            <label className="field">
              <span>{t.booking.name}</span>
              <input
                autoComplete="name"
                required
                value={contact.name}
                onChange={(e) => setContact({ ...contact, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t.booking.phone}</span>
              <input
                type="tel"
                autoComplete="tel"
                required
                value={contact.phone}
                onChange={(e) => setContact({ ...contact, phone: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t.booking.email}</span>
              <input
                type="email"
                autoComplete="email"
                required
                value={contact.email}
                onChange={(e) => setContact({ ...contact, email: e.target.value })}
              />
              <small className="muted">{t.booking.emailHint}</small>
            </label>
            <label className="check">
              <input
                type="checkbox"
                required
                checked={contact.acceptTerms}
                onChange={(e) => setContact({ ...contact, acceptTerms: e.target.checked })}
              />
              <span>{t.booking.acceptTerms}</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={contact.marketingConsent}
                onChange={(e) => setContact({ ...contact, marketingConsent: e.target.checked })}
              />
              <span>{t.booking.marketing}</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>
                {t.booking.rememberMe}
                <small className="muted remember-hint">{t.booking.rememberMeHint}</small>
              </span>
            </label>
            <button className="btn btn--block" disabled={busy}>
              {t.booking.sendCode}
            </button>
          </form>
        ) : null}

        {step === 'code' && hold ? (
          <form className="form" onSubmit={confirm}>
            <h2>{t.booking.codeTitle}</h2>
            <p className="muted">{fill(t.booking.codeLead, { email: contact.email })}</p>
            <input
              className="code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              aria-label={t.booking.codeTitle}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <button className="btn btn--block" disabled={busy || code.length !== 6}>
              {t.booking.confirm}
            </button>
            <button
              type="button"
              className="link-btn small"
              disabled={busy}
              onClick={() => void sendCode()}
            >
              {t.booking.resend}
            </button>
          </form>
        ) : null}

        {step === 'done' && result ? (
          <section className="stack">
            <div className="done-mark" aria-hidden="true">
              ✓
            </div>
            <h1>{t.booking.doneTitle}</h1>
            <p>{t.booking.doneLead}</p>
            <div className="summary">
              <span className="big">
                {result.appointment.time} ·{' '}
                {formatDay(result.appointment.date, tag, { short: true })}
              </span>
              <span>
                {result.appointment.service.name} · {result.appointment.staff.displayName}
              </span>
              <span className="muted small">
                {salon.name}, {salon.addressLine}, {salon.city}
              </span>
            </div>
            <button
              type="button"
              className="btn btn--quiet btn--block"
              onClick={() => downloadIcs(result.appointment)}
            >
              {t.booking.addToCalendar}
            </button>
            <Link className="btn btn--quiet btn--block" href={`/${locale}/m/${result.manageToken}`}>
              {t.booking.manage}
            </Link>
            {result.signedIn ? (
              <section className="install-app install-app--card">
                <strong>{t.booking.appTitle}</strong>
                <p className="small muted">{t.booking.appLead}</p>
                <Link className="btn btn--block" href={`/${locale}/c`}>
                  {t.booking.installApp}
                </Link>
              </section>
            ) : (
              <Link className="link-btn small" href={`/${locale}/c`}>
                {t.visits.allVisits}
              </Link>
            )}
          </section>
        ) : null}
      </main>
    </div>
  );
}

function ServiceList({
  salon,
  onPick,
}: {
  salon: PublicLocation;
  onPick: (serviceId: string) => void;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const groups = [
    ...salon.categories.map((c) => ({
      id: c.id,
      name: c.name,
      services: salon.services.filter((s) => s.categoryId === c.id),
    })),
    {
      id: 'none',
      name: salon.categories.length ? t.booking.otherServices : '',
      services: salon.services.filter((s) => !s.categoryId),
    },
  ].filter((g) => g.services.length > 0);

  return (
    <section>
      {groups.map((g) => (
        <div key={g.id}>
          {g.name ? <h3 className="group-title">{g.name}</h3> : null}
          <ul className="choice-list">
            {g.services.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => onPick(s.id)}>
                  <span className="c-name">{s.name}</span>
                  <span className="c-meta">
                    {s.durationMinutes} {t.common.minutes}
                    {s.description ? ` · ${s.description}` : ''}
                  </span>
                  <span className="c-price">{formatPrice(s.priceGrosze, tag)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** The held time with a countdown; when it runs out the client picks a time again. */
function HoldSummary({
  hold,
  onExpired,
  children,
}: {
  hold: Hold;
  onExpired: () => void;
  children?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [left, setLeft] = useState(() => Date.parse(hold.expiresAt) - Date.now());
  const expired = useRef(onExpired);
  expired.current = onExpired;
  useEffect(() => {
    const timer = window.setInterval(() => {
      const ms = Date.parse(hold.expiresAt) - Date.now();
      setLeft(ms);
      if (ms <= 0) {
        window.clearInterval(timer);
        expired.current();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hold.expiresAt]);
  const seconds = Math.max(0, Math.floor(left / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <div className="summary">
      <span className="big">
        {hold.time} · {formatDay(hold.date, tag, { short: true })}
      </span>
      <span>
        {hold.serviceName} · {hold.staffName} · {formatPrice(hold.priceGrosze, tag)}
      </span>
      <span className="small muted timer" aria-live="polite">
        {fill(t.booking.heldFor, { time: clock })}
      </span>
      {children}
    </div>
  );
}
