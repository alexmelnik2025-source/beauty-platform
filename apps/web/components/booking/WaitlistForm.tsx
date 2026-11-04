'use client';

import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';
import type { WaitlistJoined } from '@/lib/types';
import { ErrorBox } from '../ui';

/**
 * Task 50: on a full day — "Powiadom mnie, gdy zwolni się termin". Name and email (prefilled
 * from the booking form if typed), the salon's terms; one email when a time becomes free.
 */
export function WaitlistForm(props: {
  slug: string;
  serviceId: string;
  staffId?: string;
  date: string;
  name: string;
  email: string;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(props.name);
  const [email, setEmail] = useState(props.email);
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api<WaitlistJoined>(`/v1/public/locations/${props.slug}/waitlist`, {
        method: 'POST',
        auth: false,
        body: {
          serviceId: props.serviceId,
          ...(props.staffId ? { staffId: props.staffId } : {}),
          date: props.date,
          name,
          email,
          locale,
          acceptTerms: accept,
        },
      });
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
        {t.booking.waitlistDone}
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
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
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
