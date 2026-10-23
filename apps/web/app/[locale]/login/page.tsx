'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthPage } from '@/components/AuthPage';
import { ErrorBox } from '@/components/ui';
import { api, setAccessToken } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';

export default function LoginPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ accessToken: string }>('/v1/auth/login', {
        method: 'POST',
        auth: false,
        body: { email, password, clientType: 'web' },
      });
      setAccessToken(res.accessToken);
      router.push(`/${locale}/app`);
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <AuthPage>
      <div className="stack">
        <h1>{t.auth.loginTitle}</h1>
        <p className="muted">{t.auth.loginLead}</p>
      </div>
      <form className="form" onSubmit={submit}>
        <ErrorBox>{error}</ErrorBox>
        <label className="field">
          <span>{t.auth.email}</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t.auth.password}</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
