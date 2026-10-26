'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatDay, formatPrice } from '@/lib/time';
import type { ClientAppointment, ClientPerson } from '@/lib/types';
import { InstallApp } from '../InstallApp';
import { ErrorBox, LanguageSwitch, Spinner, Wordmark } from '../ui';

type Scope = 'upcoming' | 'past';

/** Code errors after which the client simply needs a fresh code. */
const NEW_CODE_NEEDED = ['CODE_EXPIRED', 'CODE_NOT_SENT', 'TOO_MANY_ATTEMPTS'];

/** Builds the booking page link that starts with the same service and staff member. */
export function bookAgainHref(locale: string, a: ClientAppointment): string | null {
  if (!a.bookAgain) return null;
  const params = new URLSearchParams({ service: a.bookAgain.serviceId });
  if (a.bookAgain.staffId) params.set('staff', a.bookAgain.staffId);
  return `/${locale}/b/${a.bookAgain.slug}?${params.toString()}`;
}

export function ClientHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="salon-head">
      <div className="salon-head-inner">
        <div className="top">
          <Wordmark />
          <LanguageSwitch />
        </div>
        {children}
      </div>
    </header>
  );
}

/** "My visits": sign in with an email code, then all visits in every salon. */
export function ClientVisits() {
  const { t } = useI18n();
  const [person, setPerson] = useState<ClientPerson | null | undefined>(undefined);

  useEffect(() => {
    api<ClientPerson>('/v1/client/me', { auth: false })
      .then(setPerson)
      .catch(() => setPerson(null));
  }, []);

  return (
    <div className="booking">
      <ClientHeader>
        <h1 className="salon-name">{t.visits.title}</h1>
      </ClientHeader>
      <main className="narrow stack">
        {person === undefined ? (
          <Spinner />
        ) : person === null ? (
          <SignIn onSignedIn={setPerson} />
        ) : (
          <VisitList person={person} onSignedOut={() => setPerson(null)} />
        )}
      </main>
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: (person: ClientPerson) => void }) {
  const { t, locale } = useI18n();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/v1/client/auth/code', {
        method: 'POST',
        auth: false,
        body: { email: email.trim(), locale },
      });
      setSentTo(email.trim());
      setCode('');
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ person: ClientPerson }>('/v1/client/auth/verify', {
        method: 'POST',
        auth: false,
        body: { email: sentTo, code, locale, clientType: 'web' },
      });
      onSignedIn(res.person);
    } catch (err) {
      setError(
        err instanceof ApiError && NEW_CODE_NEEDED.includes(err.code)
          ? t.visits.newCodeNeeded
          : errorText(t, err),
      );
    } finally {
      setBusy(false);
    }
  }

  if (!sentTo) {
    return (
      <form className="form" onSubmit={sendCode}>
        <p className="muted">{t.visits.lead}</p>
        <ErrorBox>{error}</ErrorBox>
        <label className="field">
          <span>{t.visits.email}</span>
          <input
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <button className="btn btn--block" disabled={busy}>
          {t.visits.sendCode}
        </button>
      </form>
    );
  }

  return (
    <form className="form" onSubmit={verify}>
      <p className="muted">{fill(t.visits.codeSent, { email: sentTo })}</p>
      <ErrorBox>{error}</ErrorBox>
      <input
        className="code-input"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        required
        aria-label={t.visits.code}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
      />
      <button className="btn btn--block" disabled={busy || code.length !== 6}>
        {t.visits.signIn}
      </button>
      <div className="row">
        <button
          type="button"
          className="link-btn small"
          disabled={busy}
          onClick={() => void sendCode()}
        >
          {t.visits.resend}
        </button>
        <button
          type="button"
          className="link-btn small"
          onClick={() => {
            setSentTo('');
            setError('');
          }}
        >
          {t.visits.otherEmail}
        </button>
      </div>
    </form>
  );
}

function VisitList({ person, onSignedOut }: { person: ClientPerson; onSignedOut: () => void }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [scope, setScope] = useState<Scope>('upcoming');
  const [items, setItems] = useState<ClientAppointment[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setItems(null);
    setError('');
    try {
      const res = await api<{ items: ClientAppointment[] }>('/v1/client/appointments', {
        auth: false,
        query: { scope },
      });
      setItems(res.items);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setError(errorText(t, err));
    }
  }, [scope, t, onSignedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  async function signOut() {
    try {
      await api('/v1/client/auth/logout', { method: 'POST', auth: false });
    } finally {
      onSignedOut();
    }
  }

  return (
    <>
      <div className="tabs" role="group">
        {(['upcoming', 'past'] as const).map((s) => (
          <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)}>
            {s === 'upcoming' ? t.visits.upcoming : t.visits.past}
          </button>
        ))}
      </div>
      <ErrorBox>{error}</ErrorBox>
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <p className="note">{scope === 'upcoming' ? t.visits.emptyUpcoming : t.visits.emptyPast}</p>
      ) : (
        <ul className="list">
          {items.map((a) => {
            const again = scope === 'past' ? bookAgainHref(locale, a) : null;
            return (
              <li key={a.id}>
                <Link className="list-row" href={`/${locale}/c/${a.id}`}>
                  <span className="grow">
                    <strong>
                      {a.time} · {formatDay(a.date, tag, { short: true })}
                    </strong>
                    <span className="small">
                      {a.service.name} · {a.staff.displayName} ·{' '}
                      {formatPrice(a.service.priceGrosze, tag)}
                    </span>
                    <span className="small muted">
                      {a.salon.name}
                      {a.status === 'confirmed' ? '' : ` · ${t.appointment.status[a.status]}`}
                    </span>
                  </span>
                </Link>
                {again ? (
                  <Link className="btn btn--quiet btn--small" href={again}>
                    {t.visits.bookAgain}
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <InstallApp lead={t.visits.installLead} />
      <p className="small muted">{fill(t.visits.signedInAs, { email: person.email })}</p>
      <button type="button" className="link-btn small" onClick={() => void signOut()}>
        {t.common.signOut}
      </button>
    </>
  );
}
