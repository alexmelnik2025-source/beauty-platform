'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthPage } from '@/components/AuthPage';
import { ErrorBox } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';

export default function RegisterPage() {
  const { t, locale } = useI18n();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/v1/auth/register', { method: 'POST', auth: false, body: { ...form, locale } });
      setSent(true);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthPage>
        <h1>{t.auth.checkEmailTitle}</h1>
        <p>{fill(t.auth.checkEmail, { email: form.email })}</p>
      </AuthPage>
    );
  }

  return (
    <AuthPage>
      <h1>{t.auth.registerTitle}</h1>
      <form className="form" onSubmit={submit}>
        <ErrorBox>{error}</ErrorBox>
        <label className="field">
          <span>{t.auth.name}</span>
          <input
            autoComplete="name"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="field">
          <span>{t.auth.email}</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label className="field">
          <span>
            {t.auth.password} · {t.auth.passwordHint}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </label>
        <button className="btn btn--block" disabled={busy}>
          {t.auth.createAccount}
        </button>
      </form>
      <p className="small">
        {t.auth.haveAccount} <Link href={`/${locale}/login`}>{t.auth.signIn}</Link>
      </p>
    </AuthPage>
  );
}
