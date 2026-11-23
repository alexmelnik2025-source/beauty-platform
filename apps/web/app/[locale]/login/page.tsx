'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthPage } from '@/components/AuthPage';
import { ErrorBox, FieldError } from '@/components/ui';
import { api, ApiError, setAccessToken } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';

type Field = 'email' | 'password';

/**
 * Task 656 (owner's rule: errors at the field): which field an answer of the server is about —
 * a wrong e-mail or password under the password, an unconfirmed address under the e-mail.
 * Null when it is about neither (too many tries, no network): then the box on top says it.
 */
function fieldOf(err: unknown): Field | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'INVALID_CREDENTIALS') return 'password';
  if (err.code === 'EMAIL_NOT_VERIFIED') return 'email';
  if (err.code === 'VALIDATION_ERROR' && Array.isArray(err.details)) {
    const paths = (err.details as { path?: string }[]).map((d) => d.path);
    if (paths.includes('email')) return 'email';
    if (paths.includes('password')) return 'password';
  }
  return null;
}

/** A plain look at an e-mail address: something@something.something, no spaces. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Task 686: what is missing or wrong before asking the server, first field first. */
function checkLogin(
  email: string,
  password: string,
  t: ReturnType<typeof useI18n>['t'],
): { field: Field; text: string } | null {
  if (!email.trim()) return { field: 'email', text: t.onboarding.fieldRequired };
  if (!EMAIL_SHAPE.test(email.trim())) return { field: 'email', text: t.booking.emailInvalid };
  if (!password) return { field: 'password', text: t.onboarding.fieldRequired };
  return null;
}

export default function LoginPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  /** An error shown at its own field; typing in that field takes it away. */
  const [problem, setProblem] = useState<{ field: Field; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    // Task 686 (owner's rule: errors at the field): an empty or wrong field used to get the
    // browser's bubble; now it is said under the field and the cursor goes there.
    const own = checkLogin(email, password, t);
    if (own) {
      setProblem(own);
      e.currentTarget.querySelector<HTMLInputElement>(`input[name="${own.field}"]`)?.focus();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await api<{ accessToken: string }>('/v1/auth/login', {
        method: 'POST',
        auth: false,
        body: { email, password, clientType: 'web' },
      });
      setAccessToken(res.accessToken);
      // Only paths inside this site: never redirect to another address. Without one — straight to
      // the calendar (task 428: no extra hop through /app).
      const next = new URLSearchParams(window.location.search).get('next');
      router.push(next && /^\/[a-z]{2}\//.test(next) ? next : `/${locale}/app/calendar`);
    } catch (err) {
      const field = fieldOf(err);
      if (field) setProblem({ field, text: errorText(t, err) });
      else setError(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <AuthPage>
      <div className="stack">
        <h1>{t.auth.loginTitle}</h1>
        <p className="muted">{t.auth.loginLead}</p>
      </div>
      <form noValidate className="form" onSubmit={(e) => void submit(e)}>
        <ErrorBox>{error}</ErrorBox>
        <label className="field">
          <span>{t.auth.email}</span>
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            aria-invalid={problem?.field === 'email' || undefined}
            aria-describedby={problem?.field === 'email' ? 'login-email-error' : undefined}
            onChange={(e) => {
              setEmail(e.target.value);
              if (problem?.field === 'email') setProblem(null);
            }}
          />
          <FieldError
            id="login-email-error"
            text={problem?.field === 'email' ? problem.text : undefined}
          />
        </label>
        <label className="field">
          <span>{t.auth.password}</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            aria-invalid={problem?.field === 'password' || undefined}
            aria-describedby={problem?.field === 'password' ? 'login-password-error' : undefined}
            onChange={(e) => {
              setPassword(e.target.value);
              if (problem?.field === 'password') setProblem(null);
            }}
          />
          <FieldError
            id="login-password-error"
            text={problem?.field === 'password' ? problem.text : undefined}
          />
        </label>
        <button className="btn btn--block" disabled={busy}>
          {t.auth.signIn}
        </button>
      </form>
      <p className="small">
        {t.auth.noAccount} <Link href={`/${locale}/register`}>{t.auth.createAccount}</Link>
      </p>
    </AuthPage>
  );
}
