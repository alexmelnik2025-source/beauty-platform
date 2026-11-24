'use client';

import { DRINK_ICON, MOOD_ICON, OFFERED_DRINKS } from '@/components/wishes/wishes';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { LanguagePicker } from '@/components/Languages';
import { SalonPhotos } from '@/components/SalonPhotos';
import { ShareBooking } from '@/components/ShareBooking';
import { ErrorBox, FieldError, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatCoordinates, parseCoordinates } from '@/lib/coordinates';
import { dialForTimeZone, normalizePhone } from '@/lib/phone';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { CURRENCIES, currencyName } from '@/lib/time';
import { salonTimeZones } from '@/lib/country';
import type { LegalTemplates, Location } from '@/lib/types';

type LocationSettings = Location;
type LegalKey = 'bookingTerms' | 'privacyPolicy';
const LEGAL_KEYS: LegalKey[] = ['bookingTerms', 'privacyPolicy'];

/** Task Q6: the sections of "Ustawienia", as a list; each opens its own card. */
const SECTIONS = ['booking', 'salon', 'wishes', 'rebook', 'share', 'legal'] as const;
type SectionKey = (typeof SECTIONS)[number];
const SECTION_ICON: Record<SectionKey, string> = {
  booking: '📅',
  salon: '🏠',
  wishes: '☕',
  rebook: '🔁',
  share: '🔗',
  legal: '📄',
};

/** The section in the address ("?s=legal"), so a reload or a link from "Pierwsze kroki" opens it. */
function sectionFromAddress(): SectionKey | null {
  const s = new URLSearchParams(window.location.search).get('s');
  return SECTIONS.find((key) => key === s) ?? null;
}

/**
 * Task 680 (owner's rule: errors at the field): the fields of "Ustawienia" that can show an error
 * under them, and the card each one is in — saving from another card opens it.
 */
const FIELD_SECTION = {
  name: 'salon',
  addressLine: 'salon',
  city: 'salon',
  postalCode: 'salon',
  phone: 'salon',
  minLeadMinutes: 'booking',
  bookingHorizonDays: 'booking',
  clientCancelDeadlineMinutes: 'booking',
  rebookReminderDays: 'rebook',
} as const satisfies Record<string, SectionKey>;
type SettingsField = keyof typeof FIELD_SECTION;
const FIELDS = Object.keys(FIELD_SECTION) as SettingsField[];
/** The whole numbers each number field takes (as the server checks them). */
const NUMBER_RANGE: Partial<Record<SettingsField, [number, number]>> = {
  minLeadMinutes: [0, 10080],
  bookingHorizonDays: [1, 365],
  clientCancelDeadlineMinutes: [0, 10080],
  rebookReminderDays: [7, 365],
};

/** Which field the server's answer is about; null when it is about something else. */
function settingsFieldOf(err: unknown): SettingsField | null {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return null;
  if (!Array.isArray(err.details)) return null;
  const paths = (err.details as { path?: string }[]).map((d) => d.path);
  return FIELDS.find((f) => paths.includes(f)) ?? null;
}

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
  /**
   * Task 749 (owner's rule: errors where the action is): a template that could not be fetched is
   * said under its own "Wstaw szablon", not as a box at the top of the card.
   */
  const [templateError, setTemplateError] = useState<{ key: LegalKey; text: string } | null>(null);
  const [coordinatesError, setCoordinatesError] = useState('');
  const [problem, setProblem] = useState<{ field: SettingsField; text: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // null: the list of sections (on a computer the first card stays open next to it).
  const [section, setSection] = useState<SectionKey | null>(null);

  useEffect(() => {
    setSection(sectionFromAddress());
    const back = () => setSection(sectionFromAddress());
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);

  function openSection(key: SectionKey | null) {
    setSection(key);
    setMessage('');
    const params = new URLSearchParams(window.location.search);
    if (key) params.set('s', key);
    else params.delete('s');
    const query = params.toString();
    window.history.pushState(
      window.history.state,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}`,
    );
    window.scrollTo(0, 0);
  }

  // The field with the error gets the cursor once its card is shown.
  useEffect(() => {
    if (!problem && !coordinatesError) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [problem, coordinatesError, section]);

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
  // Task 191: a salon without a place is only in the catalogue's list, not on its map.
  const loadedWithoutPlace = loc.latitude === null || loc.longitude === null;
  const link = `${window.location.origin}/${locale}/b/${loc.slug}`;
  /** Editing a field takes its error away. */
  const clear = (key: keyof LocationSettings) => {
    if (problem?.field === key) setProblem(null);
  };
  const num = (key: keyof LocationSettings) => (e: { target: { value: string } }) => {
    // An emptied number field stays empty (NaN) and says so at "Zapisz", not 0.
    setForm({ ...form, [key]: e.target.value === '' ? Number.NaN : Number(e.target.value) });
    clear(key);
  };
  const text = (key: keyof LocationSettings) => (e: { target: { value: string } }) => {
    setForm({ ...form, [key]: e.target.value });
    clear(key);
  };
  const invalid = (field: SettingsField) => ({
    'aria-invalid': problem?.field === field || undefined,
    'aria-describedby': problem?.field === field ? `settings-${field}-error` : undefined,
  });
  const fieldError = (field: SettingsField) => (
    <FieldError
      id={`settings-${field}-error`}
      text={problem?.field === field ? problem.text : undefined}
    />
  );
  /** What is wrong with a field, said the same way before saving and after the server's answer. */
  function fieldText(field: SettingsField): string {
    const range = NUMBER_RANGE[field];
    if (range) return fill(t.guard.numberRange, { min: String(range[0]), max: String(range[1]) });
    if (field === 'phone') return t.booking.phoneInvalid;
    if (field === 'postalCode' && form?.postalCode.trim()) return t.settings.postalCodeInvalid;
    return t.onboarding.fieldRequired;
  }
  /** The first field the server would refuse, checked here so the error is at the field at once. */
  function firstProblem(f: LocationSettings): SettingsField | null {
    for (const field of FIELDS) {
      if (field === 'rebookReminderDays' && f.rebookReminderDays === 0) continue;
      const range = NUMBER_RANGE[field];
      if (range) {
        const value = f[field] as number;
        if (!Number.isInteger(value) || value < range[0] || value > range[1]) return field;
      } else if (field === 'phone') {
        const phone = f.phone?.trim() ? normalizePhone(f.phone, dialForTimeZone(f.timezone)) : '';
        if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) return field;
      } else if (field === 'postalCode') {
        if (f.postalCode.trim().length < 3) return field;
      } else if (!String(f[field] ?? '').trim()) return field;
    }
    return null;
  }
  function showProblem(field: SettingsField) {
    setProblem({ field, text: fieldText(field) });
    if ((section ?? 'booking') !== FIELD_SECTION[field]) openSection(FIELD_SECTION[field]);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form || !loc) return;
    const point = parseCoordinates(coordinates);
    if (point === 'invalid') {
      // The error stays at its field (task Q6), so its card opens.
      setCoordinatesError(t.directory.coordinatesInvalid);
      if ((section ?? 'booking') !== 'booking') openSection('booking');
      return;
    }
    setCoordinatesError('');
    const wrong = firstProblem(form);
    if (wrong) {
      showProblem(wrong);
      return;
    }
    setProblem(null);
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
          askMood: form.askMood,
          askDrink: form.askDrink,
          drinks: form.drinks,
          askNote: form.askNote,
          minLeadMinutes: form.minLeadMinutes,
          bookingHorizonDays: form.bookingHorizonDays,
          clientCancelDeadlineMinutes: form.clientCancelDeadlineMinutes,
          reminderHoursBefore: form.reminderHoursBefore,
          waitlistHoldMinutes: form.waitlistHoldMinutes,
          rebookReminderDays: form.rebookReminderDays,
          rebookReminderText: form.rebookReminderText ?? '',
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
      const field = settingsFieldOf(err);
      if (field) showProblem(field);
      else setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function insertTemplate(key: LegalKey) {
    if (!form) return;
    if (form[key]?.trim() && !window.confirm(t.legal.replaceAsk)) return;
    setTemplateError(null);
    try {
      const templates = await api<LegalTemplates>(`${url}/legal-templates`);
      setForm({ ...form, [key]: templates[key] });
      setTemplateNote(true);
    } catch (err) {
      setTemplateError({ key, text: errorText(t, err) });
    }
  }

  const missing = placeholders(form.bookingTerms, form.privacyPolicy);
  // Task Q6: changes wait in the form until "Zapisz" in the bar; "Odrzuć" brings back what is saved.
  const dirty =
    JSON.stringify(form) !== JSON.stringify(loc) ||
    coordinates !== formatCoordinates(loc.latitude, loc.longitude);
  const shown: SectionKey = section ?? 'booking';
  const title: Record<SectionKey, string> = {
    booking: t.settings.booking,
    salon: t.settings.salon,
    wishes: t.wishes.settingsTitle,
    rebook: t.settings.rebookTitle,
    share: t.share.title,
    legal: t.legal.title,
  };

  function discard() {
    if (!loc) return;
    setForm(loc);
    setCoordinates(formatCoordinates(loc.latitude, loc.longitude));
    setCoordinatesError('');
    setProblem(null);
    setTemplateNote(false);
    setError('');
  }

  return (
    <>
      {/* Task 655: on a phone an open section shows only "‹ Ustawienia" and its own title — not the page title twice. */}
      <div className={`page-head${section ? ' settings-head--section' : ''}`}>
        <h1>{t.settings.title}</h1>
      </div>
      <form
        ref={formRef}
        className={`page form settings${section ? '' : ' settings--home'}`}
        onSubmit={save}
        noValidate
      >
        {dirty ? (
          <div className="unsaved-bar" role="region" aria-label={t.settings.unsaved}>
            <strong className="grow">{t.settings.unsaved}</strong>
            <button type="button" className="btn btn--quiet" onClick={discard} disabled={busy}>
              {t.settings.discard}
            </button>
            <button
              className="btn"
              disabled={busy}
              aria-describedby={error ? 'settings-save-error' : undefined}
            >
              {t.common.save}
            </button>
            {/* Task 829 (owner's rule: errors where the action is): a refused save is said under
                "Zapisz" in this bar, not in a box inside the open card. */}
            <FieldError id="settings-save-error" text={error} />
          </div>
        ) : null}
        <nav className="settings-nav" aria-label={t.settings.title}>
          <ul className="list">
            {SECTIONS.map((key) => (
              <li key={key}>
                <button
                  type="button"
                  className="list-row"
                  aria-current={shown === key ? 'page' : undefined}
                  onClick={() => openSection(key)}
                >
                  <span className="settings-icon" aria-hidden="true">
                    {SECTION_ICON[key]}
                  </span>
                  <span className="grow">
                    <strong>{title[key]}</strong>
                    <span className="small muted">{t.settings.sections[key]}</span>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="settings-card">
          <button
            type="button"
            className="link-btn settings-back"
            onClick={() => openSection(null)}
          >
            ‹ {t.settings.title}
          </button>
          {dirty ? null : <ErrorBox>{error}</ErrorBox>}
          {message ? (
            <p className="note" role="status">
              {message}
            </p>
          ) : null}
          {shown === 'booking' ? (
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
                    value={Number.isNaN(form.minLeadMinutes) ? '' : form.minLeadMinutes}
                    {...invalid('minLeadMinutes')}
                    onChange={num('minLeadMinutes')}
                  />
                  {fieldError('minLeadMinutes')}
                </label>
                <label className="field">
                  <span>{t.settings.horizon}</span>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={Number.isNaN(form.bookingHorizonDays) ? '' : form.bookingHorizonDays}
                    {...invalid('bookingHorizonDays')}
                    onChange={num('bookingHorizonDays')}
                  />
                  {fieldError('bookingHorizonDays')}
                </label>
              </div>
              {loadedWithoutPlace ? (
                <p className="note" role="note">
                  {t.directory.notOnMap}
                </p>
              ) : null}
              <label className="field">
                <span>{t.directory.coordinates}</span>
                <input
                  value={coordinates}
                  inputMode="decimal"
                  placeholder="52.23251, 20.95634"
                  aria-invalid={coordinatesError ? true : undefined}
                  aria-describedby={coordinatesError ? 'coordinates-error' : undefined}
                  onChange={(e) => {
                    setCoordinates(e.target.value);
                    setCoordinatesError('');
                  }}
                />
                {coordinatesError ? (
                  <span className="field-error" id="coordinates-error" role="alert">
                    {coordinatesError}
                  </span>
                ) : null}
                <span className="small muted">{t.directory.coordinatesHint}</span>
              </label>
              <div className="row">
                <label className="field">
                  <span>{t.settings.deadline}</span>
                  <input
                    type="number"
                    min={0}
                    max={10080}
                    value={
                      Number.isNaN(form.clientCancelDeadlineMinutes)
                        ? ''
                        : form.clientCancelDeadlineMinutes
                    }
                    {...invalid('clientCancelDeadlineMinutes')}
                    onChange={num('clientCancelDeadlineMinutes')}
                  />
                  {fieldError('clientCancelDeadlineMinutes')}
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
              <label className="field">
                <span>{t.settings.reminder}</span>
                <select value={form.reminderHoursBefore} onChange={num('reminderHoursBefore')}>
                  {[2, 3, 6, 12, 24, 48, 0].map((h) => (
                    <option key={h} value={h}>
                      {h === 0 ? t.settings.reminderNone : `${h} ${t.settings.reminderHours}`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t.settings.waitlistHold}</span>
                <select value={form.waitlistHoldMinutes} onChange={num('waitlistHoldMinutes')}>
                  {[0, 10, 15, 30, 60].map((m) => (
                    <option key={m} value={m}>
                      {m === 0
                        ? t.settings.waitlistHoldOff
                        : `${m} ${t.settings.waitlistHoldMinutes}`}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          ) : null}
          {shown === 'salon' ? (
            <>
              <section className="section">
                <h2>{t.settings.salon}</h2>
                <label className="field">
                  <span>{t.settings.name}</span>
                  <input required value={form.name} {...invalid('name')} onChange={text('name')} />
                  {fieldError('name')}
                </label>
                <label className="field">
                  <span>{t.settings.address}</span>
                  <input
                    required
                    value={form.addressLine}
                    {...invalid('addressLine')}
                    onChange={text('addressLine')}
                  />
                  {fieldError('addressLine')}
                </label>
                <div className="row">
                  <label className="field">
                    <span>{t.settings.city}</span>
                    <input
                      required
                      value={form.city}
                      {...invalid('city')}
                      onChange={text('city')}
                    />
                    {fieldError('city')}
                  </label>
                  <label className="field">
                    <span>{t.settings.postalCode}</span>
                    <input
                      required
                      value={form.postalCode}
                      {...invalid('postalCode')}
                      onChange={text('postalCode')}
                    />
                    {fieldError('postalCode')}
                  </label>
                </div>
                <label className="field">
                  <span>{t.settings.phone}</span>
                  <input
                    type="tel"
                    value={form.phone ?? ''}
                    {...invalid('phone')}
                    onChange={text('phone')}
                  />
                  {fieldError('phone')}
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
            </>
          ) : null}
          {shown === 'wishes' ? (
            <section className="section" aria-labelledby="wishes-title">
              <h2 id="wishes-title">{t.wishes.settingsTitle}</h2>
              <p className="small muted">{t.wishes.settingsHint}</p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.askMood}
                  onChange={(e) => setForm({ ...form, askMood: e.target.checked })}
                />
                <span>
                  {MOOD_ICON.chat} {MOOD_ICON.quiet} {MOOD_ICON.relax} {t.wishes.askMood}
                </span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.askDrink}
                  onChange={(e) => setForm({ ...form, askDrink: e.target.checked })}
                />
                <span>
                  {DRINK_ICON.coffee} {t.wishes.askDrink}
                </span>
              </label>
              {form.askDrink ? (
                <fieldset className="field" style={{ marginLeft: 28 }}>
                  <legend className="small">{t.wishes.drinksOffered}</legend>
                  <div className="row">
                    {OFFERED_DRINKS.map((d) => (
                      <label className="check" key={d}>
                        <input
                          type="checkbox"
                          checked={form.drinks.includes(d)}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              drinks: e.target.checked
                                ? OFFERED_DRINKS.filter((x) => x === d || form.drinks.includes(x))
                                : form.drinks.filter((x) => x !== d),
                            })
                          }
                        />
                        <span>
                          {DRINK_ICON[d]} {t.wishes.drink[d]}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.askNote}
                  onChange={(e) => setForm({ ...form, askNote: e.target.checked })}
                />
                <span>✍️ {t.wishes.askNote}</span>
              </label>
            </section>
          ) : null}
          {shown === 'rebook' ? (
            <section className="section" aria-labelledby="rebook-title">
              <h2 id="rebook-title">{t.settings.rebookTitle}</h2>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.rebookReminderDays > 0}
                  onChange={(e) => {
                    setForm({ ...form, rebookReminderDays: e.target.checked ? 28 : 0 });
                    clear('rebookReminderDays');
                  }}
                />
                <span>{t.settings.rebookOn}</span>
              </label>
              {form.rebookReminderDays > 0 ? (
                <>
                  <label className="field">
                    <span>{t.settings.rebookDays}</span>
                    <input
                      type="number"
                      min={7}
                      max={365}
                      value={Number.isNaN(form.rebookReminderDays) ? '' : form.rebookReminderDays}
                      {...invalid('rebookReminderDays')}
                      onChange={num('rebookReminderDays')}
                    />
                    {fieldError('rebookReminderDays')}
                  </label>
                  <label className="field">
                    <span>{t.settings.rebookText}</span>
                    <textarea
                      rows={3}
                      maxLength={500}
                      placeholder={t.settings.rebookTextPlaceholder}
                      value={form.rebookReminderText ?? ''}
                      onChange={text('rebookReminderText')}
                    />
                  </label>
                </>
              ) : null}
              <p className="small muted">{t.settings.rebookHint}</p>
            </section>
          ) : null}
          {shown === 'share' ? <ShareBooking slug={loc.slug} name={loc.name} /> : null}
          {shown === 'legal' ? (
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
                      aria-describedby={
                        templateError?.key === key ? `legal-template-error-${key}` : undefined
                      }
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
                  <FieldError
                    id={`legal-template-error-${key}`}
                    text={templateError?.key === key ? templateError.text : undefined}
                  />
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
          ) : null}
        </div>
      </form>
    </>
  );
}
