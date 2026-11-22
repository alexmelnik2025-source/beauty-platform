'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthPage } from '@/components/AuthPage';
import { ErrorBox, FieldError } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';

type Field = 'name' | 'email' | 'password';
const FIELDS: Field[] = ['name', 'email', 'password'];

/**
 * Task 656 (owner's rule: errors at the field): the fields the server's validation answer is
 * about; empty when it is about something else (then the box on top says it).
 */
function fieldsOf(err: unknown): Field[] {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return [];
  if (!Array.isArray(err.details)) return [];
  const paths = (err.details as { path?: string }[]).map((d) => d.path);
  return FIELDS.filter((f) => paths.includes(f));
}

export default function RegisterPage() {
  const { t, locale } = useI18n();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  /** Fields with an error shown under them; typing in a field takes its error away. */
  const [problems, setProblems] = useState<Field[]>([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setProblems([]);
    try {
      await api('/v1/auth/register', { method: 'POST', auth: false, body: { ...form, locale } });
      setSent(true);
    } catch (err) {
      const fields = fieldsOf(err);
      if (fields.length > 0) setProblems(fields);
      else setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  const problemText: Record<Field, string> = {
    name: t.booking.nameInvalid,
    email: t.booking.emailInvalid,
    password: t.auth.passwordHint,
  };
  const set = (field: Field, value: string) => {
    setForm({ ...form, [field]: value });
    if (problems.includes(field)) setProblems(problems.filter((f) => f !== field));
  };
  const invalid = (field: Field) => ({
    'aria-invalid': problems.includes(field) || undefined,
    'aria-describedby': problems.includes(field) ? `register-${field}-error` : undefined,
  });
  const fieldError = (field: Field) => (
    <FieldError
      id={`register-${field}-error`}
      text={problems.includes(field) ? problemText[field] : undefined}
    />
  );

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
            {...invalid('name')}
            onChange={(e) => set('name', e.target.value)}
          />
          {fieldError('name')}
        </label>
        <label className="field">
          <span>{t.auth.email}</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={form.email}
            {...invalid('email')}
            onChange={(e) => set('email', e.target.value)}
          />
          {fieldError('email')}
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
            {...invalid('password')}
            onChange={(e) => set('password', e.target.value)}
          />
          {fieldError('password')}
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
