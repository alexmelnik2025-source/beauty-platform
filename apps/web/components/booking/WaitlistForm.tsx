'use client';

import { useState, type FormEvent } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';
import { normalizePhone } from '@/lib/phone';
import type { WaitlistJoined } from '@/lib/types';
import { ErrorBox, FieldError } from '../ui';

/**
 * Task 50: on a full day — "Powiadom mnie, gdy zwolni się termin". Name and email (prefilled
 * from the booking form if typed), the salon's terms; one email when a time becomes free.
 * Task Q8: a client signed in to "My visits" can tick "Zapisz mnie automatycznie, gdy zwolni się
 * termin" (with a phone): the first time that frees up is booked for them at once.
 */
type Problems = Partial<Record<'name' | 'phone' | 'email', string>>;

/**
 * Task Q5 (errors at the field): the server's answer about the name, phone or e-mail as errors at
 * those fields; null when it is about something else (then the box on top says it).
 */
function fieldProblems(t: ReturnType<typeof useI18n>['t'], err: unknown): Problems | null {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return null;
  if (!Array.isArray(err.details)) return null;
  const texts = {
    name: t.booking.nameInvalid,
    phone: t.booking.phoneInvalid,
    email: t.booking.emailInvalid,
  } as const;
  const found: Problems = {};
  for (const detail of err.details as { path?: string }[]) {
    const field = detail.path as keyof typeof texts;
    if (field in texts) found[field] = texts[field];
  }
  return Object.keys(found).length > 0 ? found : null;
}

export function WaitlistForm(props: {
  slug: string;
  serviceId: string;
  staffId?: string;
  date: string;
  name: string;
  email: string;
  /** Task Q8: the signed-in client's email (their own list, automatic booking possible). */
  signedInAs?: string | null;
  phone?: string;
  /** The salon's country dialling code for a phone typed without it. */
  dial?: string;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(props.name);
  const [email, setEmail] = useState(props.email);
  const [accept, setAccept] = useState(false);
  const [auto, setAuto] = useState(false);
  const [phone, setPhone] = useState(props.phone ?? '');
  /** Errors shown at their own field (task Q5); typing in the field takes its error away. */
  const [problems, setProblems] = useState<Problems>({});
  const [doneAuto, setDoneAuto] = useState(false);
  const signedIn = Boolean(props.signedInAs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setProblems({});
    const common = {
      serviceId: props.serviceId,
      ...(props.staffId ? { staffId: props.staffId } : {}),
      date: props.date,
      name,
      locale,
      acceptTerms: accept,
    };
    const typedPhone = phone.trim() ? normalizePhone(phone, props.dial) : '';
    if (signedIn && auto && !typedPhone) {
      setBusy(false);
      setProblems({ phone: t.booking.waitlistAutoPhone });
      return;
    }
    try {
      if (signedIn) {
        // Task Q8: the signed-in client's own list (the email is theirs, confirmed already).
        await api<WaitlistJoined>(`/v1/client/waitlist/locations/${props.slug}`, {
          method: 'POST',
          auth: false,
          body: {
            ...common,
            ...(typedPhone ? { phone: typedPhone } : {}),
            autoBook: auto,
          },
        });
      } else {
        await api<WaitlistJoined>(`/v1/public/locations/${props.slug}/waitlist`, {
          method: 'POST',
          auth: false,
          body: { ...common, email },
        });
      }
      setDoneAuto(signedIn && auto);
      setDone(true);
    } catch (err) {
      const found = fieldProblems(t, err);
      if (found) setProblems(found);
      else setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  const fixed = (field: keyof Problems) =>
    setProblems((current) => {
      if (!current[field]) return current;
      const { [field]: _gone, ...rest } = current;
      return rest;
    });

  if (done) {
    return (
      <p className="note" role="status">
        {doneAuto ? t.booking.waitlistAutoDone : t.booking.waitlistDone}
      </p>
    );
  }
  if (!open) {
    return (
      <button type="button" className="btn btn--quiet" onClick={() => setOpen(true)}>
        {t.booking.waitlistOpen}
      </button>
    );
  }
  return (
    <form className="form stack" onSubmit={submit} aria-label={t.booking.waitlistOpen}>
      <p className="small muted">{t.booking.waitlistHint}</p>
      <ErrorBox>{error}</ErrorBox>
      <label className="field">
        <span>{t.booking.name}</span>
        <input
          required
          maxLength={100}
          // The button the client pressed is gone — the cursor goes to the first field.
          autoFocus
          autoComplete="name"
          value={name}
          aria-invalid={problems.name ? true : undefined}
          aria-describedby={problems.name ? 'waitlist-name-error' : undefined}
          onChange={(e) => {
            fixed('name');
            setName(e.target.value);
          }}
        />
        <FieldError id="waitlist-name-error" text={problems.name} />
      </label>
      {signedIn ? (
        <p className="small muted">{props.signedInAs}</p>
      ) : (
        <label className="field">
          <span>{t.booking.email}</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            aria-invalid={problems.email ? true : undefined}
            aria-describedby={problems.email ? 'waitlist-email-error' : undefined}
            onChange={(e) => {
              fixed('email');
              setEmail(e.target.value);
            }}
          />
          <FieldError id="waitlist-email-error" text={problems.email} />
        </label>
      )}
      {signedIn ? (
        <label className="check">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => {
              fixed('phone');
              setAuto(e.target.checked);
            }}
          />
          <span>
            {t.booking.waitlistAuto}
            <small className="muted remember-hint">{t.booking.waitlistAutoHint}</small>
          </span>
        </label>
      ) : null}
      {signedIn && auto ? (
        <label className="field">
          <span>{t.booking.phone}</span>
          <input
            type="tel"
            autoComplete="tel"
            value={phone}
            aria-invalid={problems.phone ? true : undefined}
            aria-describedby={problems.phone ? 'waitlist-phone-error' : undefined}
            onChange={(e) => {
              fixed('phone');
              setPhone(e.target.value);
            }}
          />
          <FieldError id="waitlist-phone-error" text={problems.phone} />
        </label>
      ) : null}
      <label className="check">
        <input
          type="checkbox"
          required
          checked={accept}
          onChange={(e) => setAccept(e.target.checked)}
        />
        <span>
          {t.legal.acceptBefore}
          <a href={`/${locale}/b/${props.slug}/regulamin`} target="_blank" rel="noopener">
            {t.legal.acceptTerms}
          </a>
          {t.legal.acceptMiddle}
          <a href={`/${locale}/b/${props.slug}/privacy`} target="_blank" rel="noopener">
            {t.legal.acceptPrivacy}
          </a>
          {t.legal.acceptAfter}
        </span>
      </label>
      <button className="btn" disabled={busy}>
        {t.booking.waitlistSubmit}
      </button>
    </form>
  );
}
