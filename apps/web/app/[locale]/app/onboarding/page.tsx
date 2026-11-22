'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { AuthPage } from '@/components/AuthPage';
import { ErrorBox, FieldError } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import {
  browserSalonTimeZone,
  currencyForTimeZone,
  regionForTimeZone,
  salonTimeZones,
} from '@/lib/country';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { CURRENCIES, currencyName } from '@/lib/time';

type Field = 'orgName' | 'locationName' | 'addressLine' | 'city' | 'postalCode';
const REQUIRED: Field[] = ['orgName', 'addressLine', 'city', 'postalCode'];
/** The server's names of the fields of a new location → the fields of this form. */
const LOCATION_FIELDS: Record<string, Field> = {
  name: 'locationName',
  addressLine: 'addressLine',
  city: 'city',
  postalCode: 'postalCode',
};

/** The fields a validation answer of the server is about (task 657). */
function fieldsOf(err: unknown, map: Record<string, Field>): Field[] {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return [];
  if (!Array.isArray(err.details)) return [];
  return (err.details as { path?: string }[])
    .map((d) => map[d.path ?? ''])
    .filter((f): f is Field => Boolean(f));
}

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
  /** Task 657: errors at their own field (owner's rule); typing in a field takes its error away. */
  const [problems, setProblems] = useState<Field[]>([]);
  /**
   * Task 657: the company already created by an earlier try whose salon then failed (a field
   * the server did not take, no network) — trying again adds the salon to it instead of
   * creating a second company with the same name.
   */
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: Field) => (e: { target: { value: string } }) => {
    setForm({ ...form, [key]: e.target.value });
    if (problems.includes(key)) setProblems(problems.filter((f) => f !== key));
  };
  const invalid = (key: Field) => ({
    'aria-invalid': problems.includes(key) || undefined,
    'aria-describedby': problems.includes(key) ? `onboarding-${key}-error` : undefined,
  });
  const fieldError = (key: Field) => (
    <FieldError
      id={`onboarding-${key}-error`}
      text={problems.includes(key) ? t.onboarding.fieldRequired : undefined}
    />
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    // Only spaces pass the browser's own check, but not the server's: said at the field at once.
    const empty = REQUIRED.filter((key) => form[key].trim() === '');
    setProblems(empty);
    if (empty.length > 0) return;
    setBusy(true);
    let org = created;
    try {
      if (!org) {
        const res = await api<{ id: string }>('/v1/organizations', {
          method: 'POST',
          body: { name: form.orgName },
        });
        org = { id: res.id, name: form.orgName };
        setCreated(org);
      } else if (org.name !== form.orgName) {
        await api(`/v1/organizations/${org.id}`, { method: 'PATCH', body: { name: form.orgName } });
        org = { ...org, name: form.orgName };
        setCreated(org);
      }
      await api(`/v1/organizations/${org.id}/locations`, {
        method: 'POST',
        body: {
          name: form.locationName.trim() || form.orgName,
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
      const fields = org ? fieldsOf(err, LOCATION_FIELDS) : fieldsOf(err, { name: 'orgName' });
      if (fields.length > 0) setProblems(fields);
      else setError(errorText(t, err));
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
          <input required value={form.orgName} {...invalid('orgName')} onChange={set('orgName')} />
          {fieldError('orgName')}
        </label>
        <label className="field">
          <span>{t.onboarding.locationName}</span>
          <input
            value={form.locationName}
            {...invalid('locationName')}
            onChange={set('locationName')}
          />
          {fieldError('locationName')}
        </label>
        <label className="field">
          <span>{t.onboarding.address}</span>
          <input
            required
            value={form.addressLine}
            {...invalid('addressLine')}
            onChange={set('addressLine')}
          />
          {fieldError('addressLine')}
        </label>
        <div className="row">
          <label className="field">
            <span>{t.onboarding.city}</span>
            <input required value={form.city} {...invalid('city')} onChange={set('city')} />
            {fieldError('city')}
          </label>
          <label className="field">
            <span>{t.onboarding.postalCode}</span>
            <input
              required
              pattern={poland ? '\\d{2}-\\d{3}' : undefined}
              placeholder={poland ? '00-000' : undefined}
              value={form.postalCode}
              {...invalid('postalCode')}
              onChange={set('postalCode')}
            />
            {fieldError('postalCode')}
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
