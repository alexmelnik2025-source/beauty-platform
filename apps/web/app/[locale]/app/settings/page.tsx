'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { LanguagePicker } from '@/components/Languages';
import { SalonPhotos } from '@/components/SalonPhotos';
import { ShareBooking } from '@/components/ShareBooking';
import { ErrorBox, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { formatCoordinates, parseCoordinates } from '@/lib/coordinates';
import { dialForTimeZone, normalizePhone } from '@/lib/phone';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { CURRENCIES, currencyName } from '@/lib/time';
import { salonTimeZones } from '@/lib/country';
import type { LegalTemplates, Location } from '@/lib/types';

type LocationSettings = Location;
type LegalKey = 'bookingTerms' | 'privacyPolicy';
const LEGAL_KEYS: LegalKey[] = ['bookingTerms', 'privacyPolicy'];

/** Placeholders like {KRS} that the salon still has to replace, each once. */
function placeholders(...texts: (string | null)[]): string[] {
  return [...new Set(texts.join('\n').match(/\{[A-Z_]+\}/g) ?? [])];
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
  const [coordinates, setCoordinates] = useState('');
  const [templateNote, setTemplateNote] = useState(false);

  useEffect(() => {
    api<LocationSettings>(url)
      .then((l) => {
        setLoc(l);
        setForm(l);
        setCoordinates(formatCoordinates(l.latitude, l.longitude));
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
    const point = parseCoordinates(coordinates);
    if (point === 'invalid') {
      setError(t.directory.coordinatesInvalid);
      return;
    }
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
          latitude: point?.latitude ?? null,
          longitude: point?.longitude ?? null,
          phone: form.phone ? normalizePhone(form.phone, dialForTimeZone(form.timezone)) : null,
          currency: form.currency,
          timezone: form.timezone,
          onlineBookingEnabled: form.onlineBookingEnabled,
          minLeadMinutes: form.minLeadMinutes,
          bookingHorizonDays: form.bookingHorizonDays,
          clientCancelDeadlineMinutes: form.clientCancelDeadlineMinutes,
          slotStepMinutes: form.slotStepMinutes,
          languages: form.languages,
          description: form.description ?? '',
          // Only when changed: a salon that took bookings before the texts existed can still
          // save its other settings.
          ...Object.fromEntries(
            LEGAL_KEYS.filter((key) => (form[key] ?? '') !== (loc[key] ?? '')).map((key) => [
              key,
              form[key] ?? '',
            ]),
          ),
        },
      });
      setLoc(saved);
      setForm(saved);
      setCoordinates(formatCoordinates(saved.latitude, saved.longitude));
      setTemplateNote(false);
      setMessage(t.actions.saved);
      void session.reload();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function insertTemplate(key: LegalKey) {
    if (!form) return;
    if (form[key]?.trim() && !window.confirm(t.legal.replaceAsk)) return;
    setError('');
    try {
      const templates = await api<LegalTemplates>(`${url}/legal-templates`);
      setForm({ ...form, [key]: templates[key] });
      setTemplateNote(true);
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  const missing = placeholders(form.bookingTerms, form.privacyPolicy);

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
          <label className="field">
            <span>{t.directory.coordinates}</span>
            <input
              value={coordinates}
              inputMode="decimal"
              placeholder="52.23251, 20.95634"
              onChange={(e) => setCoordinates(e.target.value)}
            />
            <span className="small muted">{t.directory.coordinatesHint}</span>
          </label>
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
        <section className="section" aria-labelledby="legal-title">
          <h2 id="legal-title">{t.legal.title}</h2>
          <p className="small muted">{t.legal.hint}</p>
          {LEGAL_KEYS.map((key) => (
            <div className="field" key={key}>
              <label className="field">
                <span>{key === 'bookingTerms' ? t.legal.terms : t.legal.privacy}</span>
                <textarea
                  aria-label={key === 'bookingTerms' ? t.legal.terms : t.legal.privacy}
                  rows={8}
                  maxLength={50000}
                  value={form[key] ?? ''}
                  onChange={text(key)}
                />
              </label>
              <div className="row">
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => void insertTemplate(key)}
                >
                  {t.legal.useTemplate}
                </button>
                {loc[key] ? (
                  <a
                    className="btn btn--quiet"
                    href={`/${locale}/b/${loc.slug}/${key === 'bookingTerms' ? 'regulamin' : 'privacy'}`}
                    target="_blank"
                    rel="noopener"
                  >
                    {t.legal.preview}
                  </a>
                ) : null}
              </div>
            </div>
          ))}
          <span className="small muted">{t.legal.markdownHint}</span>
          {templateNote ? <p className="note">{t.legal.templateNote}</p> : null}
          {missing.length > 0 ? (
            <p className="note" role="status">
              {fill(t.legal.missing, { list: missing.join(', ') })}
            </p>
          ) : null}
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
            <span>{t.settings.timeZone}</span>
            <select value={form.timezone} onChange={text('timezone')}>
              {salonTimeZones(LOCALE_TAGS[locale]).map((z) => (
                <option key={z.timeZone} value={z.timeZone}>
                  {z.label}
                </option>
              ))}
              {/* A zone set before this list existed stays selectable. */}
              {salonTimeZones(LOCALE_TAGS[locale]).some(
                (z) => z.timeZone === form.timezone,
              ) ? null : (
                <option value={form.timezone}>{form.timezone}</option>
              )}
            </select>
            <span className="small muted">{t.settings.timeZoneHint}</span>
          </label>
          <label className="field">
            <span>{t.settings.currency}</span>
            <select value={form.currency} onChange={text('currency')}>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {currencyName(c, LOCALE_TAGS[locale])}
                </option>
              ))}
            </select>
            <span className="small muted">{t.settings.currencyHint}</span>
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
