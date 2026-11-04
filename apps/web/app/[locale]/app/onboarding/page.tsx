'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { AuthPage } from '@/components/AuthPage';
import { ErrorBox } from '@/components/ui';
import { api } from '@/lib/api';
import {
  browserSalonTimeZone,
  currencyForTimeZone,
  regionForTimeZone,
  salonTimeZones,
} from '@/lib/country';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { CURRENCIES, currencyName } from '@/lib/time';

export default function OnboardingPage() {
  const { t, locale } = useI18n();
  const [form, setForm] = useState({
    orgName: '',
    locationName: '',
    addressLine: '',
    city: '',
    postalCode: '',
  });
  // Launch task L5: the country (time zone) suggests the currency until the owner picks one.
  const [timeZone, setTimeZone] = useState('Europe/Warsaw');
  const [currency, setCurrency] = useState<string>('PLN');
  const [currencyChosen, setCurrencyChosen] = useState(false);
  // The browser's own zone, once in the browser (the server renders the page in its own zone).
  useEffect(() => {
    const own = browserSalonTimeZone();
    setTimeZone(own);
    setCurrency(currencyForTimeZone(own));
  }, []);
  const tag = LOCALE_TAGS[locale];
  const poland = regionForTimeZone(timeZone) === 'PL';
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
          timezone: timeZone,
          currency,
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
              pattern={poland ? '\\d{2}-\\d{3}' : undefined}
              placeholder={poland ? '00-000' : undefined}
              value={form.postalCode}
              onChange={set('postalCode')}
            />
          </label>
        </div>
        <label className="field">
          <span>{t.onboarding.timeZone}</span>
          <select
            value={timeZone}
            onChange={(e) => {
              setTimeZone(e.target.value);
              if (!currencyChosen) setCurrency(currencyForTimeZone(e.target.value));
            }}
          >
            {salonTimeZones(tag).map((z) => (
              <option key={z.timeZone} value={z.timeZone}>
                {z.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.settings.currency}</span>
          <select
            value={currency}
            onChange={(e) => {
              setCurrency(e.target.value);
              setCurrencyChosen(true);
            }}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {currencyName(c, tag)}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn--block" disabled={busy}>
          {t.onboarding.create}
        </button>
      </form>
    </AuthPage>
  );
}
