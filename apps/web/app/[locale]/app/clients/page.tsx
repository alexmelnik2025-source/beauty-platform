'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ClientGuard } from '@/components/guard/ClientGuard';
import { ClientLoyalty } from '@/components/loyalty/ClientLoyalty';
import { useSession } from '@/components/Session';
import { PhoneField } from '@/components/PhoneField';
import { dialForTimeZone, normalizePhone } from '@/lib/phone';
import { ErrorBox, Sheet, Spinner } from '@/components/ui';
import { api, ApiError, apiResponse } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, LOCALES, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { Customer, CustomerDetail, CustomerTags } from '@/lib/types';

type ClientRow = Customer;

type ClientDetail = CustomerDetail;

export default function ClientsPage() {
  const { t, locale } = useI18n();
  const { orgId, role, permissions } = useSession();
  // Task 240: a birthday is a contact detail.
  const contacts = permissions.viewClientContacts !== false;
  const [search, setSearch] = useState('');
  // Task 140: "haven't been for a while" — 0 = everyone.
  const [inactiveDays, setInactiveDays] = useState(0);
  // Task 224: only clients with this label; '' = everyone.
  const [tag, setTag] = useState('');
  const [tags, setTags] = useState<CustomerTags['tags']>([]);
  // Task 240: only clients with a birthday in the next 7 days.
  const [birthdays, setBirthdays] = useState(false);
  // Task 245: only clients who agreed to the salon messages.
  const [consented, setConsented] = useState(false);
  // Task 248: only clients whose first visit was in the last 30 days, newest first.
  const [newcomers, setNewcomers] = useState(false);
  // Task 262: only regular clients past their usual break with nothing booked.
  const [overdue, setOverdue] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [rows, setRows] = useState<ClientRow[] | null>(null);
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const [error, setError] = useState('');

  // Task 217: "/app/clients?open=<id>" (from "Najlepsi klienci" in the report) opens that card.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('open');
    if (id) setOpen(id);
    // Task 249: "/app/clients?new=1" (from "Nowi klienci" in the report) shows the new clients.
    if (params.get('new') === '1') setNewcomers(true);
    // Task 263: "/app/clients?overdue=1" (from "Pora wrócić" in the report).
    if (params.get('overdue') === '1') setOverdue(true);
  }, []);

  const load = useCallback(async () => {
    try {
      setRows(
        await api<ClientRow[]>(`/v1/organizations/${orgId}/customers`, {
          query: {
            search: search.trim() || undefined,
            limit: 100,
            inactiveDays: inactiveDays || undefined,
            tag: tag || undefined,
            birthdayDays: birthdays ? 7 : undefined,
            marketing: consented ? 'yes' : undefined,
            newDays: newcomers ? 30 : undefined,
            overdue: overdue ? 'yes' : undefined,
          },
        }),
      );
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [orgId, search, inactiveDays, tag, birthdays, consented, newcomers, overdue, t]);

  /** Task 224: the salon's labels for the chips above the list (refreshed after a card is saved). */
  const loadTags = useCallback(async () => {
    try {
      const res = await api<CustomerTags>(`/v1/organizations/${orgId}/customers/tags`);
      setTags(res.tags);
    } catch {
      setTags([]);
    }
  }, [orgId]);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  /** Task 21: the owner downloads all clients as a CSV file (column names in the cabinet language). */
  async function exportCsv(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    setError('');
    try {
      const lang = (['pl', 'uk', 'ru', 'en'] as const).find((l) => l === locale) ?? 'pl';
      const res = await apiResponse(`/v1/organizations/${orgId}/customers/export.csv`, {
        query: { lang },
      });
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ??
        'klienci.csv';
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await res.blob());
      link.download = name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <>
      <div className="page-head">
        <h1>{t.clients.title}</h1>
        <div className="page-head__actions">
          {role === 'owner' && (
            <button
              type="button"
              className="btn btn--quiet btn--small"
              title={t.clients.exportHint}
              disabled={exporting}
              onClick={() => void exportCsv()}
            >
              {t.clients.export}
            </button>
          )}
          <button type="button" className="btn btn--small" onClick={() => setOpen('new')}>
            + {t.clients.add}
          </button>
        </div>
      </div>
      <div className="page">
        <input
          className="input"
          type="search"
          placeholder={t.clients.search}
          aria-label={t.actions.search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="field">
          <span>{t.clients.inactive.label}</span>
          <select
            className="input"
            value={inactiveDays}
            onChange={(e) => setInactiveDays(Number(e.target.value))}
          >
            <option value={0}>{t.clients.inactive.all}</option>
            {[30, 60, 90, 180].map((days) => (
              <option key={days} value={days}>
                {fill(t.clients.inactive.days, { days: String(days) })}
              </option>
            ))}
          </select>
        </label>
        {inactiveDays ? <p className="small muted">{t.clients.inactive.hint}</p> : null}
        <div className="chips tag-filter">
          {contacts ? (
            <>
              <button
                type="button"
                aria-pressed={birthdays}
                onClick={() => setBirthdays(!birthdays)}
              >
                🎂 {t.clients.birthdays}
              </button>
              <button
                type="button"
                aria-pressed={consented}
                title={t.clients.consentedHint}
                onClick={() => setConsented(!consented)}
              >
                ✉️ {t.clients.consented}
              </button>
            </>
          ) : null}
          <button
            type="button"
            aria-pressed={newcomers}
            title={t.clients.newcomersHint}
            onClick={() => setNewcomers(!newcomers)}
          >
            🌱 {t.clients.newcomers}
          </button>
          <button
            type="button"
            aria-pressed={overdue}
            title={t.clients.overdueHint}
            onClick={() => setOverdue(!overdue)}
          >
            ⏰ {t.clients.overdue}
          </button>
        </div>
        {newcomers ? <p className="small muted">{t.clients.newcomersHint}</p> : null}
        {overdue ? <p className="small muted">{t.clients.overdueHint}</p> : null}
        {tags.length ? (
          <div className="chips tag-filter" role="group" aria-label={t.clients.tagFilter}>
            <button type="button" aria-pressed={tag === ''} onClick={() => setTag('')}>
              {t.clients.allTags}
            </button>
            {tags.map((item) => (
              <button
                key={item.tag}
                type="button"
                aria-pressed={tag === item.tag}
                onClick={() => setTag(tag === item.tag ? '' : item.tag)}
              >
                {item.tag} <span className="muted">{item.clients}</span>
              </button>
            ))}
          </div>
        ) : null}
        <ErrorBox>{error}</ErrorBox>
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <p className="note">
            {birthdays
              ? t.clients.birthdaysNone
              : newcomers
                ? t.clients.newcomersNone
                : overdue
                  ? t.clients.overdueNone
                  : consented
                    ? t.clients.consentedNone
                    : inactiveDays
                      ? t.clients.inactive.none
                      : search || tag
                        ? t.clients.notFound
                        : t.clients.empty}
          </p>
        ) : (
          <ul className="list">
            {rows.map((c) => (
              <li key={c.id}>
                <button type="button" className="list-row" onClick={() => setOpen(c.id)}>
                  <span className="grow">
                    <strong>{c.name}</strong>
                    <span className="small muted">
                      {[c.phone, c.email].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {c.birthday && birthdays ? (
                    <span className="chip">🎂 {birthdayText(c.birthday, locale, t)}</span>
                  ) : null}
                  {c.tags?.length ? (
                    <span className="chips">
                      {c.tags.slice(0, 2).map((tag) => (
                        <span key={tag} className="chip">
                          {tag}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {open ? (
        <ClientSheet
          orgId={orgId}
          id={open === 'new' ? null : open}
          knownTags={tags.map((item) => item.tag)}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            void load();
            void loadTags();
          }}
        />
      ) : null}
    </>
  );
}

/** "vip, , broda " → ['vip', 'broda'] (the server keeps at most 10 labels of 30 characters). */
/** Task 240: "MM-DD" → "15 marca", or "dziś" on the day. */
function birthdayText(
  birthday: string,
  locale: string,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const now = new Date();
  const today = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (birthday === today) return t.clients.birthdayToday;
  const [month, day] = birthday.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale as keyof typeof LOCALE_TAGS] ?? 'pl-PL', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2000, month - 1, day)));
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Task 240: day and month of the birthday, no year; '' while either is not chosen. */
function BirthdayField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t, locale } = useI18n();
  const [month, setMonth] = useState(value ? Number(value.slice(0, 2)) : 0);
  const [day, setDay] = useState(value ? Number(value.slice(3, 5)) : 0);
  const monthName = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    month: 'long',
    timeZone: 'UTC',
  });
  function change(nextMonth: number, nextDay: number) {
    const last = nextMonth ? DAYS_IN_MONTH[nextMonth - 1]! : 31;
    const fixedDay = Math.min(nextDay, last);
    setMonth(nextMonth);
    setDay(fixedDay);
    onChange(
      nextMonth && fixedDay
        ? `${String(nextMonth).padStart(2, '0')}-${String(fixedDay).padStart(2, '0')}`
        : '',
    );
  }
  const days = month ? DAYS_IN_MONTH[month - 1]! : 31;
  return (
    <fieldset className="field">
      <legend>🎂 {t.clients.birthday}</legend>
      <div className="row">
        <select
          aria-label={t.clients.birthdayDay}
          value={day}
          onChange={(e) => change(month, Number(e.target.value))}
        >
          <option value={0}>—</option>
          {Array.from({ length: days }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select
          aria-label={t.clients.birthdayMonth}
          value={month}
          onChange={(e) => change(Number(e.target.value), day)}
        >
          <option value={0}>—</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>
              {monthName.format(new Date(Date.UTC(2000, m - 1, 1)))}
            </option>
          ))}
        </select>
      </div>
      <span className="small muted">{t.clients.birthdayHint}</span>
    </fieldset>
  );
}

function tagList(input: string): string[] {
  return [
    ...new Set(
      input
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

function ClientSheet({
  orgId,
  id,
  knownTags,
  onClose,
  onSaved,
}: {
  orgId: string;
  id: string | null;
  /** Task 226: the salon's labels, most used first — offered under the label field. */
  knownTags: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const session = useSession();
  const dial = dialForTimeZone(session.location.timezone);
  const [client, setClient] = useState<ClientDetail | null>(null);
  const [form, setForm] = useState({
    name: '',
    phone: `+${dial} `,
    email: '',
    locale: locale as string,
    note: '',
    tags: '',
    birthday: '',
  });
  const [duplicate, setDuplicate] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    api<ClientDetail>(`/v1/organizations/${orgId}/customers/${id}`)
      .then((c) => {
        setClient(c);
        setForm({
          name: c.name,
          phone: c.phone ?? '',
          email: c.email ?? '',
          locale: c.locale,
          note: c.note ?? '',
          tags: (c.tags ?? []).join(', '),
          birthday: c.birthday ?? '',
        });
      })
      .catch((err) => setError(errorText(t, err)));
  }, [id, orgId, t]);

  async function save(e: FormEvent, allowDuplicatePhone = false) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const tags = form.tags
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      if (client) {
        await api(`/v1/organizations/${orgId}/customers/${client.id}`, {
          method: 'PATCH',
          body: {
            version: client.version,
            name: form.name,
            phone: normalizePhone(form.phone, dial),
            email: form.email || null,
            locale: form.locale,
            note: form.note || null,
            tags,
            // Task 240: sent only when changed, so a hidden birthday is never wiped.
            ...(form.birthday !== (client.birthday ?? '')
              ? { birthday: form.birthday || null }
              : {}),
          },
        });
      } else {
        await api(`/v1/organizations/${orgId}/customers`, {
          method: 'POST',
          body: {
            name: form.name,
            phone: normalizePhone(form.phone, dial),
            ...(form.email ? { email: form.email } : {}),
            locale: form.locale,
            ...(form.note ? { note: form.note } : {}),
            tags,
            ...(form.birthday ? { birthday: form.birthday } : {}),
            allowDuplicatePhone,
          },
        });
      }
      onSaved();
    } catch (err) {
      setDuplicate(err instanceof ApiError && err.code === 'CUSTOMER_PHONE_EXISTS');
      setError(errorText(t, err));
      setBusy(false);
    }
  }

  if (id && !client) {
    return (
      <Sheet title={t.clients.title} onClose={onClose}>
        {error ? <ErrorBox>{error}</ErrorBox> : <Spinner />}
      </Sheet>
    );
  }

  const erasedOn = client?.anonymizedAt
    ? new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', year: 'numeric' }).format(
        new Date(client.anonymizedAt),
      )
    : null;

  return (
    <Sheet title={client ? client.name : t.clients.add} onClose={onClose}>
      {erasedOn ? (
        <p className="note" role="status">
          {fill(t.clients.anonymized, { date: erasedOn })}
        </p>
      ) : null}
      <form className="form" onSubmit={(e) => void save(e)} hidden={Boolean(erasedOn)}>
        <ErrorBox>{error}</ErrorBox>
        {duplicate && !client ? (
          <button
            type="button"
            className="btn btn--quiet"
            onClick={(e) => void save(e as unknown as FormEvent, true)}
          >
            {t.clients.addAnyway}
          </button>
        ) : null}
        <label className="field">
          <span>{t.clients.name}</span>
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <div className="row">
          <PhoneField
            label={t.clients.phone}
            required
            value={form.phone}
            defaultDial={dial}
            onChange={(phone) => setForm({ ...form, phone })}
          />
          <label className="field">
            <span>{t.clients.email}</span>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </label>
        </div>
        <label className="field">
          <span>{t.clients.language}</span>
          <select
            value={form.locale}
            onChange={(e) => setForm({ ...form, locale: e.target.value })}
          >
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        {session.permissions.viewClientContacts !== false && (!client || client.phone !== null) ? (
          <BirthdayField
            key={client?.id ?? 'new'}
            value={form.birthday}
            onChange={(birthday) => setForm((f) => ({ ...f, birthday }))}
          />
        ) : null}
        <label className="field">
          <span>{t.clients.tags}</span>
          <input
            placeholder={t.clients.tagsHint}
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
          />
        </label>
        {(() => {
          const have = tagList(form.tags);
          const lower = new Set(have.map((tag) => tag.toLocaleLowerCase()));
          const offer =
            have.length >= 10
              ? []
              : knownTags.filter((tag) => !lower.has(tag.toLocaleLowerCase())).slice(0, 8);
          return offer.length ? (
            <div className="chips tag-filter" role="group" aria-label={t.clients.addTag}>
              {offer.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setForm({ ...form, tags: [...have, tag].join(', ') })}
                >
                  + {tag}
                </button>
              ))}
            </div>
          ) : null;
        })()}
        <label className="field">
          <span>{t.clients.note}</span>
          <textarea
            maxLength={1000}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </label>
        {client && client.marketingConsent !== null ? (
          <p className="small muted">
            {t.clients.marketing}: {client.marketingConsent ? t.actions.yes : t.actions.no}
          </p>
        ) : null}
        <button className="btn btn--block" disabled={busy}>
          {t.common.save}
        </button>
      </form>
      {client ? <ClientSummary summary={client.summary} tag={tag} /> : null}
      {client ? (
        <section className="section">
          <h3>{t.clients.visits}</h3>
          {client.visits.length === 0 ? (
            <p className="small muted">{t.clients.noVisits}</p>
          ) : (
            <ul className="history">
              {client.visits.map((v) => (
                <li key={v.id}>
                  <span>
                    {v.serviceName} · {v.staffName}
                    <span className="muted"> · {t.appointment.status[v.status]}</span>
                  </span>
                  <span className="muted">
                    {new Intl.DateTimeFormat(tag, {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    }).format(new Date(v.start))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {client ? <ClientLoyalty orgId={orgId} customerId={client.id} /> : null}
      {client && session.role !== 'staff' ? (
        <ClientGuard orgId={orgId} customerId={client.id} />
      ) : null}
      {client && !erasedOn && session.role === 'owner' ? (
        <ClientPrivacy orgId={orgId} client={client} onErased={onSaved} />
      ) : null}
    </Sheet>
  );
}

/**
 * Task 21 (GDPR, owner only): download everything kept about the client, or erase the
 * personal data — visits stay in the statistics without them.
 */
function ClientPrivacy({
  orgId,
  client,
  onErased,
}: {
  orgId: string;
  client: ClientDetail;
  onErased: () => void;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const path = `/v1/organizations/${orgId}/customers/${client.id}`;

  async function download() {
    setError('');
    try {
      const data = await api<unknown>(`${path}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `client-${client.id}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  async function erase() {
    setBusy(true);
    setError('');
    try {
      await api(`${path}/anonymize`, { method: 'POST', body: { version: client.version } });
      onErased();
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section className="section stack">
      <h3>{t.clients.privacy}</h3>
      <p className="small muted">{t.clients.privacyHint}</p>
      <ErrorBox>{error}</ErrorBox>
      <button type="button" className="btn btn--quiet btn--block" onClick={() => void download()}>
        {t.clients.exportOne}
      </button>
      {confirming ? (
        <div className="summary" role="alertdialog" aria-label={t.clients.erase}>
          <span>{t.clients.eraseConfirm}</span>
          <div className="row">
            <button
              type="button"
              className="btn btn--quiet"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {t.actions.no}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy}
              onClick={() => void erase()}
            >
              {t.clients.eraseYes}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn--danger btn--block"
          onClick={() => setConfirming(true)}
        >
          {t.clients.erase}
        </button>
      )}
    </section>
  );
}

/**
 * Task 98: how the client comes — counted by the server over every visit the user may see; the
 * paid sum only for owners and managers (one line per currency of the salons).
 */
function ClientSummary({ summary, tag }: { summary: CustomerDetail['summary']; tag: string }) {
  const { t } = useI18n();
  const day = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric' }).format(
          new Date(iso),
        )
      : '—';
  const tiles: [string, string | number][] = [
    [t.clients.summary.completed, summary.completed],
    [t.clients.summary.noShow, summary.noShow],
    [t.clients.summary.cancelledByClient, summary.cancelledByClient],
    [t.clients.summary.cancelledBySalon, summary.cancelledBySalon],
    [t.clients.summary.upcoming, summary.upcoming],
    [t.clients.summary.firstVisit, day(summary.firstVisitAt)],
    [t.clients.summary.lastVisit, day(summary.lastVisitAt)],
  ];
  // Task 250: "usually every N days" and when the client may come next.
  if (summary.rhythmDays && summary.lastVisitAt) {
    tiles.push([
      t.clients.summary.rhythm,
      fill(t.clients.summary.rhythmValue, {
        days: String(summary.rhythmDays),
        date: day(
          new Date(
            new Date(summary.lastVisitAt).getTime() + summary.rhythmDays * 86_400_000,
          ).toISOString(),
        ),
      }),
    ]);
  }
  // Task 261: what and with whom the client books most often (from two visits).
  for (const [label, fav] of [
    [t.clients.summary.favoriteService, summary.favoriteService],
    [t.clients.summary.favoriteStaff, summary.favoriteStaff],
  ] as const) {
    if (fav) {
      tiles.push([
        label,
        fill(t.clients.summary.favoriteValue, { name: fav.name, n: String(fav.visits) }),
      ]);
    }
  }
  if (summary.paid) {
    tiles.push([
      t.clients.summary.paid,
      summary.paid.length === 0
        ? '—'
        : summary.paid.map((p) => formatPrice(p.amountGrosze, p.currency, tag)).join(' + '),
    ]);
  }
  return (
    <section className="section" data-testid="client-summary">
      <h3>{t.clients.summary.title}</h3>
      <div className="stats">
        {tiles.map(([label, value]) => (
          <div key={label} className="stat">
            <span className="small muted">{label}</span>
            <b>{value}</b>
          </div>
        ))}
      </div>
    </section>
  );
}
