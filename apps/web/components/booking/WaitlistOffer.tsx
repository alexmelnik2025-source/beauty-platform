'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatDay } from '@/lib/time';
import type { ClientPerson } from '@/lib/types';
import { ErrorBox } from '../ui';

type State =
  | { kind: 'closed' }
  | { kind: 'checking' }
  | { kind: 'signedOut' }
  | { kind: 'open'; email: string };

/**
 * Under the free times (task 51): "No time that suits you? Tell me when one frees up". A
 * client signed in to "My visits" picks a day — also a full one — and gets one email when a
 * visit that day is cancelled or moved and a time is free for them.
 */
export function WaitlistOffer(props: {
  slug: string;
  serviceId: string;
  /** undefined = any specialist. */
  staffId?: string;
  /** The days of the booking strip; the chosen one is preselected. */
  days: string[];
  day: string;
}) {
  const { t, locale } = useI18n();
  const w = t.waitlist;
  const tag = LOCALE_TAGS[locale];
  const [state, setState] = useState<State>({ kind: 'closed' });
  const [date, setDate] = useState(props.day || props.days[0] || '');
  const [joined, setJoined] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function open() {
    setState({ kind: 'checking' });
    try {
      const me = await api<ClientPerson>('/v1/client/me', { auth: false });
      setState({ kind: 'open', email: me.email });
    } catch {
      setState({ kind: 'signedOut' });
    }
  }

  async function join() {
    setBusy(true);
    setError('');
    try {
      await api('/v1/client/waitlist', {
        method: 'POST',
        auth: false,
        body: {
          slug: props.slug,
          serviceId: props.serviceId,
          ...(props.staffId ? { staffId: props.staffId } : {}),
          date,
        },
      });
      setJoined(date);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOO_MANY_WAITLIST') setError(w.tooMany);
      else if (err instanceof ApiError && err.status === 401) setState({ kind: 'signedOut' });
      else setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === 'closed' || state.kind === 'checking') {
    return (
      <button
        type="button"
        className="link-btn small"
        disabled={state.kind === 'checking'}
        onClick={() => void open()}
      >
        {w.open}
      </button>
    );
  }
  if (state.kind === 'signedOut') {
    return (
      <p className="note">
        {w.signInFirst} <Link href={`/${locale}/c`}>{t.visits.title}</Link>
      </p>
    );
  }
  return (
    <section className="card stack" aria-labelledby="waitlist-title" style={{ gap: 10 }}>
      <h3 id="waitlist-title">{w.title}</h3>
      <p className="muted small">{fill(w.lead, { email: state.email })}</p>
      <label className="field">
        <span>{w.day}</span>
        <select value={date} onChange={(e) => setDate(e.target.value)}>
          {props.days.map((d) => (
            <option key={d} value={d}>
              {formatDay(d, tag)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn btn--quiet"
        disabled={busy || !date}
        onClick={() => void join()}
      >
        {w.join}
      </button>
      {joined ? (
        <p role="status" className="note">
          {fill(w.joined, { day: formatDay(joined, tag) })}
        </p>
      ) : null}
      <ErrorBox>{error}</ErrorBox>
    </section>
  );
}
