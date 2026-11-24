'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api';
import { bookWithHref, favoriteSpecialists, type FavoriteSpecialist } from '@/lib/favorite';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatDay, formatPrice } from '@/lib/time';
import type {
  ClientAppointment,
  ClientDataExport,
  ClientPerson,
  ClientVisitSummary,
} from '@/lib/types';
import { InstallApp } from '../InstallApp';
import { ClientBonuses } from './ClientBonuses';
import { ClientFavorites } from './ClientFavorites';
import { EMAIL_SHAPE } from '@/lib/contact-check';
import { ErrorBox, FieldError, LanguageSwitch, Spinner } from '../ui';
import { ClientNav } from './ClientNav';
import { ResumeBooking } from './ResumeBooking';

type Scope = 'upcoming' | 'past' | 'bonuses' | 'favorites';

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
    <>
      <ClientNav current="visits" />
      <header className="salon-head">
        <div className="salon-head-inner">
          <div className="top" style={{ justifyContent: 'flex-end' }}>
            <LanguageSwitch />
          </div>
          {children}
        </div>
      </header>
    </>
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
        {/* Task Q2: the installed app continues the booking the client started on a salon's page. */}
        <ResumeBooking />
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
  /**
   * Task 770 (owner's rule: errors where the action is): a refusal that is not about one field (no
   * connection, too many tries, …) is said under the button that was pressed — "Wyślij kod",
   * "Zaloguj się" or "Wyślij ponownie" — not as a box above the form.
   */
  const [error, setError] = useState<{ on: 'send' | 'verify' | 'resend'; text: string } | null>(
    null,
  );
  /**
   * Task 690 (owner's rule: errors at the field): an empty or wrong e-mail and a wrong or used-up
   * code are said under their field (red frame, "!"), not in the browser's bubble or a line on top.
   */
  const [emailProblem, setEmailProblem] = useState('');
  const [codeProblem, setCodeProblem] = useState('');
  const [busy, setBusy] = useState(false);

  async function sendCode(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    setError(null);
    if (!sentTo) {
      const typed = email.trim();
      const problem = !typed
        ? t.onboarding.fieldRequired
        : EMAIL_SHAPE.test(typed)
          ? ''
          : t.booking.emailInvalid;
      setEmailProblem(problem);
      if (problem) {
        e?.currentTarget.querySelector<HTMLInputElement>('input[type="email"]')?.focus();
        return;
      }
    }
    setCodeProblem('');
    setBusy(true);
    try {
      await api('/v1/client/auth/code', {
        method: 'POST',
        auth: false,
        body: { email: email.trim(), locale },
      });
      setSentTo(email.trim());
      setCode('');
    } catch (err) {
      // The server's answer about the address (e.g. too long) — under the field too.
      if (!sentTo && err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
        setEmailProblem(t.booking.emailInvalid);
      } else setError({ on: sentTo ? 'resend' : 'send', text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    // Task 702: fewer than 6 digits — said under the code (the button was silently switched off).
    if (code.length !== 6) {
      setError(null);
      setCodeProblem(t.booking.codeIncomplete);
      document.getElementById('visits-code')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setCodeProblem('');
    try {
      const res = await api<{ person: ClientPerson }>('/v1/client/auth/verify', {
        method: 'POST',
        auth: false,
        body: { email: sentTo, code, locale, clientType: 'web' },
      });
      onSignedIn(res.person);
    } catch (err) {
      if (err instanceof ApiError && NEW_CODE_NEEDED.includes(err.code)) {
        setCodeProblem(t.visits.newCodeNeeded);
      } else if (err instanceof ApiError && err.code === 'INVALID_CODE') {
        setCodeProblem(errorText(t, err));
      } else setError({ on: 'verify', text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  }

  if (!sentTo) {
    return (
      <form noValidate className="form" onSubmit={(e) => void sendCode(e)}>
        <p className="muted">{t.visits.lead}</p>
        <label className="field">
          <span>{t.visits.email}</span>
          <input
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            aria-invalid={emailProblem ? true : undefined}
            aria-describedby={emailProblem ? 'visits-email-error' : undefined}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailProblem('');
              setError(null);
            }}
          />
          <FieldError id="visits-email-error" text={emailProblem || undefined} />
        </label>
        <button
          className="btn btn--block"
          disabled={busy}
          aria-describedby={error?.on === 'send' ? 'visits-send-error' : undefined}
        >
          {t.visits.sendCode}
        </button>
        <FieldError id="visits-send-error" text={error?.on === 'send' ? error.text : undefined} />
      </form>
    );
  }

  return (
    <form noValidate className="form" onSubmit={(e) => void verify(e)}>
      <p className="muted">{fill(t.visits.codeSent, { email: sentTo })}</p>
      <input
        id="visits-code"
        className="code-input"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        required
        aria-label={t.visits.code}
        aria-invalid={codeProblem ? true : undefined}
        aria-describedby={codeProblem ? 'visits-code-error' : undefined}
        value={code}
        onChange={(e) => {
          setCode(e.target.value.replace(/\D/g, ''));
          setCodeProblem('');
          setError(null);
        }}
      />
      <FieldError id="visits-code-error" text={codeProblem || undefined} />
      <button
        className="btn btn--block"
        disabled={busy}
        aria-describedby={error?.on === 'verify' ? 'visits-verify-error' : undefined}
      >
        {t.visits.signIn}
      </button>
      <FieldError id="visits-verify-error" text={error?.on === 'verify' ? error.text : undefined} />
      <div className="row">
        <button
          type="button"
          className="link-btn small"
          disabled={busy}
          aria-describedby={error?.on === 'resend' ? 'visits-resend-error' : undefined}
          onClick={() => void sendCode()}
        >
          {t.visits.resend}
        </button>
        <button
          type="button"
          className="link-btn small"
          onClick={() => {
            setSentTo('');
            setError(null);
            setCodeProblem('');
          }}
        >
          {t.visits.otherEmail}
        </button>
      </div>
      <FieldError id="visits-resend-error" text={error?.on === 'resend' ? error.text : undefined} />
    </form>
  );
}

function VisitList({ person, onSignedOut }: { person: ClientPerson; onSignedOut: () => void }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [scope, setScope] = useState<Scope>('upcoming');
  // Task 416: "Wszystkie ulubione" on the home page opens the "Ulubione" tab.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'favorites') {
      setScope('favorites');
    }
  }, []);
  const [items, setItems] = useState<ClientAppointment[] | null>(null);
  // Task 203: "Twoi specjaliści" above the coming visits, from the client's own history.
  const [mine, setMine] = useState<FavoriteSpecialist[]>([]);
  // Task 292: "Twoje wizyty" above the past visits — all time, every salon.
  const [summary, setSummary] = useState<ClientVisitSummary | null>(null);
  // Task 297: the history of one salon only (its slug); null = every salon.
  const [salon, setSalon] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setItems(null);
    setMine([]);
    setSummary(null);
    setSalon(null);
    setError('');
    if (scope === 'bonuses' || scope === 'favorites') return;
    try {
      const list = (which: 'upcoming' | 'past') =>
        api<{ items: ClientAppointment[] }>('/v1/client/appointments', {
          auth: false,
          query: { scope: which },
        });
      const [res, past, sum] = await Promise.all([
        list(scope),
        scope === 'upcoming' ? list('past') : Promise.resolve(null),
        scope === 'past'
          ? api<ClientVisitSummary>('/v1/client/me/summary', { auth: false })
          : Promise.resolve(null),
      ]);
      setItems(res.items);
      if (past) setMine(favoriteSpecialists(past.items));
      setSummary(sum);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setError(errorText(t, err));
    }
  }, [scope, t, onSignedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  const [downloading, setDownloading] = useState(false);
  // Task 733 (owner's rule: errors where the action is): a failed "Pobierz moje dane" is said under
  // that button at the bottom, not as a line above the visits where nobody looking at it sees it.
  const [downloadError, setDownloadError] = useState('');

  /** GDPR access and portability (task 40): everything the salons keep, as a JSON file. */
  async function downloadData() {
    setDownloading(true);
    setDownloadError('');
    try {
      const data = await api<ClientDataExport>('/v1/client/export', { auth: false });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `my-data-${data.exportedAt.slice(0, 10)}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setDownloadError(errorText(t, err));
    } finally {
      setDownloading(false);
    }
  }

  // Task 297: the salons of the history, in the order of the latest visit; the filter shows
  // only when there are two or more.
  const salons =
    scope === 'past' && items ? salonsOf(items) : ([] as { slug: string; name: string }[]);
  const shown = (items ?? []).filter((a) => salon === null || a.salon.slug === salon);

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
        {(['upcoming', 'past', 'bonuses', 'favorites'] as const).map((s) => (
          <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)}>
            {s === 'upcoming'
              ? t.visits.upcoming
              : s === 'past'
                ? t.visits.past
                : s === 'bonuses'
                  ? t.bonuses.tab
                  : t.favorites.tab}
          </button>
        ))}
      </div>
      <ErrorBox>{error}</ErrorBox>
      {scope === 'upcoming' && mine.length > 0 ? (
        <section className="stack" aria-label={t.visits.mySpecialists}>
          <h2>{t.visits.mySpecialists}</h2>
          <ul className="list">
            {mine.map((f) => (
              <li key={f.slug}>
                <span className="grow">
                  <strong>{f.staffName}</strong>
                  <span className="small">
                    {f.serviceName} · {fill(t.visits.visitsCount, { n: String(f.visits) })}
                  </span>
                  <span className="small muted">{f.salonName}</span>
                </span>
                <Link className="btn btn--small" href={bookWithHref(locale, f)}>
                  {fill(t.visits.bookWith, { staff: f.staffName })}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {scope === 'past' && summary && summary.completed > 0 ? (
        <VisitSummary summary={summary} />
      ) : null}
      {scope === 'past' && salons.length > 1 ? (
        <div className="tabs" role="group" aria-label={t.visits.salonFilter}>
          {[{ slug: null, name: t.visits.allSalons }, ...salons].map((s) => (
            <button
              key={s.slug ?? ''}
              type="button"
              aria-pressed={salon === s.slug}
              onClick={() => setSalon(s.slug)}
            >
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
      {scope === 'bonuses' ? (
        <ClientBonuses onSignedOut={onSignedOut} />
      ) : scope === 'favorites' ? (
        <ClientFavorites onSignedOut={onSignedOut} />
      ) : items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <p className="note">{scope === 'upcoming' ? t.visits.emptyUpcoming : t.visits.emptyPast}</p>
      ) : (
        <ul className="list">
          {shown.map((a) => {
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
                      {formatPrice(a.service.priceGrosze, a.currency, tag)}
                    </span>
                    <span className="small muted">
                      {a.salon.name}
                      {a.status === 'confirmed' ? '' : ` · ${t.appointment.status[a.status]}`}
                      {a.awaitingApproval ? ` · ⏳ ${t.appointment.awaitingApproval}` : ''}
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
      <p className="small muted">{t.visits.downloadDataHint}</p>
      <button
        type="button"
        className="link-btn small"
        disabled={downloading}
        aria-describedby={downloadError ? 'visits-download-error' : undefined}
        onClick={() => void downloadData()}
      >
        {t.visits.downloadData}
      </button>
      <FieldError id="visits-download-error" text={downloadError || undefined} />
      <button type="button" className="link-btn small" onClick={() => void signOut()}>
        {t.common.signOut}
      </button>
    </>
  );
}

/** Task 292: how many visits took place, in how many salons, since when, and what they cost. */
function VisitSummary({ summary }: { summary: ClientVisitSummary }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const since = summary.firstVisitAt
    ? new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', year: 'numeric' }).format(
        new Date(summary.firstVisitAt),
      )
    : null;
  const spent = summary.spent.map((s) => formatPrice(s.amountGrosze, s.currency, tag)).join(' + ');
  return (
    <section className="summary" aria-label={t.visits.summaryTitle} data-testid="visit-summary">
      <h2 className="big">{t.visits.summaryTitle}</h2>
      <span>
        {fill(t.visits.summaryVisits, { n: String(summary.completed) })}
        {summary.salons > 1
          ? ` · ${fill(t.visits.summarySalons, { n: String(summary.salons) })}`
          : ''}
        {since ? ` · ${fill(t.visits.summarySince, { date: since })}` : ''}
      </span>
      {spent ? (
        <span className="small">{fill(t.visits.summarySpent, { amount: spent })}</span>
      ) : null}
    </section>
  );
}

/** Task 297: every salon of the visits once, in the order they come (the latest visit first). */
function salonsOf(items: ClientAppointment[]): { slug: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const a of items) if (!seen.has(a.salon.slug)) seen.set(a.salon.slug, a.salon.name);
  return [...seen].map(([slug, name]) => ({ slug, name }));
}
