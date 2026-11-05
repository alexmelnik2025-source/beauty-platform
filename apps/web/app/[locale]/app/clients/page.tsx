'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ClientLoyalty } from '@/components/loyalty/ClientLoyalty';
import { useSession } from '@/components/Session';
import { PhoneField } from '@/components/PhoneField';
import { dialForTimeZone, normalizePhone } from '@/lib/phone';
import { ErrorBox, Sheet, Spinner } from '@/components/ui';
import { api, ApiError, apiResponse } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, LOCALES, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { Customer, CustomerDetail } from '@/lib/types';

type ClientRow = Customer;

type ClientDetail = CustomerDetail;

export default function ClientsPage() {
  const { t, locale } = useI18n();
  const { orgId, role } = useSession();
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const [rows, setRows] = useState<ClientRow[] | null>(null);
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(
        await api<ClientRow[]>(`/v1/organizations/${orgId}/customers`, {
          query: { search: search.trim() || undefined, limit: 100 },
        }),
      );
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [orgId, search, t]);

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
        <ErrorBox>{error}</ErrorBox>
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <p className="note">{search ? t.clients.notFound : t.clients.empty}</p>
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
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

function ClientSheet({
  orgId,
  id,
  onClose,
  onSaved,
}: {
  orgId: string;
  id: string | null;
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
        <label className="field">
          <span>{t.clients.tags}</span>
          <input
            placeholder={t.clients.tagsHint}
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
          />
        </label>
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
