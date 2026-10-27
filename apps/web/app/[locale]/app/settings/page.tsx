'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { LanguagePicker, type Spoken } from '@/components/Languages';
import { SalonPhotos } from '@/components/SalonPhotos';
import { ShareBooking } from '@/components/ShareBooking';
import { normalizePhone } from '@/components/calendar/NewItemSheet';
import { ErrorBox, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';

interface LocationSettings {
  id: string;
  name: string;
  slug: string;
  addressLine: string;
  city: string;
  postalCode: string;
  phone: string | null;
  onlineBookingEnabled: boolean;
  minLeadMinutes: number;
  bookingHorizonDays: number;
  clientCancelDeadlineMinutes: number;
  slotStepMinutes: number;
  languages: Spoken[];
  description: string | null;
  version: number;
}

export default function SettingsPage() {
  const { t, locale } = useI18n();
  const session = useSession();
  const url = `/v1/organizations/${session.orgId}/locations/${session.location.id}`;
  const [loc, setLoc] = useState<LocationSettings | null>(null);
  const [form, setForm] = useState<LocationSettings | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api<LocationSettings>(url)
      .then((l) => {
        setLoc(l);
        setForm(l);
      })
      .catch((err) => setError(errorText(t, err)));
  }, [url, t]);

  if (!form || !loc) return error ? <ErrorBox>{error}</ErrorBox> : <Spinner />;
  const link = `${window.location.origin}/${locale}/b/${loc.slug}`;
  const num = (key: keyof LocationSettings) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: Number(e.target.value) });
  const text = (key: keyof LocationSettings) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form || !loc) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await api<LocationSettings>(url, {
        method: 'PATCH',
        body: {
          version: loc.version,
          name: form.name,
          addressLine: form.addressLine,
          city: form.city,
          postalCode: form.postalCode,
          phone: form.phone ? normalizePhone(form.phone) : null,
          onlineBookingEnabled: form.onlineBookingEnabled,
          minLeadMinutes: form.minLeadMinutes,
          bookingHorizonDays: form.bookingHorizonDays,
          clientCancelDeadlineMinutes: form.clientCancelDeadlineMinutes,
          slotStepMinutes: form.slotStepMinutes,
          languages: form.languages,
          description: form.description ?? '',
        },
      });
      setLoc(saved);
      setForm(saved);
      setMessage(t.actions.saved);
      void session.reload();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>{t.settings.title}</h1>
      </div>
      <form className="page form" onSubmit={save} style={{ maxWidth: 640 }}>
        <ErrorBox>{error}</ErrorBox>
        {message ? (
          <p className="note" role="status">
            {message}
          </p>
        ) : null}
        <section className="section">
          <h2>{t.settings.booking}</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={form.onlineBookingEnabled}
              onChange={(e) => setForm({ ...form, onlineBookingEnabled: e.target.checked })}
            />
            <span>{t.settings.enabled}</span>
          </label>
          <div className="field">
            <span>{t.settings.link}</span>
            <div className="copy-field">
              <input className="input" readOnly value={link} aria-label={t.settings.link} />
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => {
                  void navigator.clipboard?.writeText(link);
                  setCopied(true);
                }}
              >
                {copied ? t.actions.copied : t.actions.copy}
              </button>
            </div>
          </div>
          <div className="row">
            <label className="field">
              <span>{t.settings.lead}</span>
              <input
                type="number"
                min={0}
                max={10080}
                value={form.minLeadMinutes}
                onChange={num('minLeadMinutes')}
              />
            </label>
            <label className="field">
              <span>{t.settings.horizon}</span>
              <input
                type="number"
                min={1}
                max={365}
                value={form.bookingHorizonDays}
                onChange={num('bookingHorizonDays')}
              />
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>{t.settings.deadline}</span>
              <input
                type="number"
                min={0}
                max={10080}
                value={form.clientCancelDeadlineMinutes}
                onChange={num('clientCancelDeadlineMinutes')}
              />
            </label>
            <label className="field">
              <span>{t.settings.step}</span>
              <select value={form.slotStepMinutes} onChange={num('slotStepMinutes')}>
                {[5, 10, 15, 30].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
        <ShareBooking slug={loc.slug} name={loc.name} />
        <section className="section">
          <h2>{t.settings.salon}</h2>
          <label className="field">
            <span>{t.settings.name}</span>
            <input required value={form.name} onChange={text('name')} />
          </label>
          <label className="field">
            <span>{t.settings.address}</span>
            <input required value={form.addressLine} onChange={text('addressLine')} />
          </label>
          <div className="row">
            <label className="field">
              <span>{t.settings.city}</span>
              <input required value={form.city} onChange={text('city')} />
            </label>
            <label className="field">
              <span>{t.settings.postalCode}</span>
              <input required value={form.postalCode} onChange={text('postalCode')} />
            </label>
          </div>
          <label className="field">
            <span>{t.settings.phone}</span>
            <input type="tel" value={form.phone ?? ''} onChange={text('phone')} />
          </label>
          <label className="field">
            <span>{t.profile.description}</span>
            <textarea
              rows={4}
              maxLength={1000}
              value={form.description ?? ''}
              onChange={text('description')}
            />
            <span className="small muted">{t.profile.descriptionHint}</span>
          </label>
          <p className="small muted">{t.profile.hoursHint}</p>
          <LanguagePicker
            title={t.languages.salonTitle}
            hint={t.languages.salonHint}
            value={form.languages ?? []}
            onChange={(languages) => setForm({ ...form, languages })}
          />
        </section>
        <SalonPhotos base={url} />
        <button className="btn" disabled={busy}>
          {t.common.save}
        </button>
      </form>
    </>
  );
}
