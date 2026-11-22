'use client';

import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';
import { normalizePhone } from '@/lib/phone';
import type { WaitlistJoined } from '@/lib/types';
import { ErrorBox } from '../ui';

/**
 * Task 50: on a full day — "Powiadom mnie, gdy zwolni się termin". Name and email (prefilled
 * from the booking form if typed), the salon's terms; one email when a time becomes free.
 * Task Q8: a client signed in to "My visits" can tick "Zapisz mnie automatycznie, gdy zwolni się
 * termin" (with a phone): the first time that frees up is booked for them at once.
 */
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
  const [phoneProblem, setPhoneProblem] = useState('');
  const [doneAuto, setDoneAuto] = useState(false);
  const signedIn = Boolean(props.signedInAs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
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
      setPhoneProblem(t.booking.waitlistAutoPhone);
      return;
    }
    setPhoneProblem('');
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
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

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
          onChange={(e) => setName(e.target.value)}
        />
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
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
      )}
      {signedIn ? (
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
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
            aria-invalid={phoneProblem ? true : undefined}
            aria-describedby={phoneProblem ? 'waitlist-phone-error' : undefined}
            onChange={(e) => setPhone(e.target.value)}
          />
          {phoneProblem ? (
            <small id="waitlist-phone-error" className="field-error" role="alert">
              {phoneProblem}
            </small>
          ) : null}
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
