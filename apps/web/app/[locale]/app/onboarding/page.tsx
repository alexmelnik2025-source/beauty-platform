'use client';

import { useState, type FormEvent } from 'react';
import { AuthPage } from '@/components/AuthPage';
import { ErrorBox } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';

export default function OnboardingPage() {
  const { t, locale } = useI18n();
  const [form, setForm] = useState({
    orgName: '',
    locationName: '',
    addressLine: '',
    city: '',
    postalCode: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const org = await api<{ id: string }>('/v1/organizations', {
        method: 'POST',
        body: { name: form.orgName },
      });
      await api(`/v1/organizations/${org.id}/locations`, {
        method: 'POST',
        body: {
          name: form.locationName || form.orgName,
          addressLine: form.addressLine,
          city: form.city,
          postalCode: form.postalCode,
          defaultLocale: locale,
        },
      });
      window.location.assign(`/${locale}/app/calendar`);
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <AuthPage>
      <div className="stack">
        <h1>{t.onboarding.title}</h1>
        <p className="muted">{t.onboarding.lead}</p>
      </div>
      <form className="form" onSubmit={submit}>
        <ErrorBox>{error}</ErrorBox>
        <label className="field">
          <span>{t.onboarding.orgName}</span>
          <input required value={form.orgName} onChange={set('orgName')} />
        </label>
        <label className="field">
          <span>{t.onboarding.locationName}</span>
          <input value={form.locationName} onChange={set('locationName')} />
        </label>
        <label className="field">
          <span>{t.onboarding.address}</span>
          <input required value={form.addressLine} onChange={set('addressLine')} />
        </label>
        <div className="row">
          <label className="field">
            <span>{t.onboarding.city}</span>
            <input required value={form.city} onChange={set('city')} />
          </label>
          <label className="field">
            <span>{t.onboarding.postalCode}</span>
            <input
              required
              pattern="\d{2}-\d{3}"
              placeholder="00-000"
              value={form.postalCode}
              onChange={set('postalCode')}
            />
          </label>
        </div>
        <button className="btn btn--block" disabled={busy}>
          {t.onboarding.create}
        </button>
      </form>
    </AuthPage>
  );
}
