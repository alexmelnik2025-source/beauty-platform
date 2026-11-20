'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import { useSession } from '../Session';
import { ErrorBox, Spinner } from '../ui';

interface BaseStatus {
  connected: boolean;
  tokenHint: string | null;
  tokenReadable: boolean;
  inventoryId: string | null;
  inventoryName: string | null;
  priceGroupId: string | null;
  warehouseId: string | null;
  lastImportAt: string | null;
  syncEveryMinutes: number;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
  importedProducts: number;
  orders: {
    enabled: boolean;
    newStatusId: string | null;
    handedStatusId: string | null;
    cancelledStatusId: string | null;
    failing: number;
  };
}

interface BaseOptions {
  inventories: {
    id: string;
    name: string;
    priceGroupIds: string[];
    defaultPriceGroupId: string | null;
    warehouseIds: string[];
    defaultWarehouseId: string | null;
  }[];
  priceGroups: { id: string; name: string; currency: string; matchesSalon: boolean }[];
  warehouses: { id: string; name: string }[];
}

/** One product of the seller's Base or file, as both lists show it. */
interface Row {
  key: string;
  name: string;
  ean: string | null;
  priceGrosze: number | null;
  stock: number | null;
  importedProductId: string | null;
  catalogProductId: string | null;
}

interface SyncRun {
  id: string;
  trigger: 'import' | 'manual' | 'schedule' | 'orders';
  startedAt: string;
  checked: number;
  changed: number;
  missing: number;
  errorCode: string | null;
}

interface ImportResult {
  created: number;
  updated: number;
  skipped: unknown[];
  photosAdded: number;
}

/** "Gotowe: …", and how many cards got their photo from the seller's links, if any. */
const importedText = (s: { imported: string; importedPhotos: string }, res: ImportResult) =>
  [
    fill(s.imported, {
      created: String(res.created),
      updated: String(res.updated),
      skipped: String(res.skipped.length),
    }),
    res.photosAdded > 0 ? fill(s.importedPhotos, { n: String(res.photosAdded) }) : '',
  ]
    .filter(Boolean)
    .join(' ');

const SYNC_EVERY = [15, 30, 60, 180, 360, 720, 1440];

/**
 * Task Q4: "Mój sklep" → "Integracje" — the seller's products come by themselves instead of being
 * typed: from its own Base (BaseLinker) in three steps (token → catalogue, prices, warehouse →
 * tick products), or from a product file (CSV, Google Merchant or Ceneo XML). Nothing is shown
 * to clients until ticked. Owners and managers only (the server checks it too).
 */
export function ShopIntegrationsSection({ base }: { base: string }) {
  const { t } = useI18n();
  const s = t.shopIntegrations;
  const [error, setError] = useState('');

  return (
    <section className="stack" aria-labelledby="integrations-title">
      <h1 id="integrations-title">{s.title}</h1>
      <p className="muted">{s.hint}</p>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <BaseCard base={`${base}/shop/integrations/base`} onError={setError} />
      <FeedCard base={`${base}/shop/integrations/feed`} onError={setError} />
      <p className="small muted">{s.nothingAutomatic}</p>
    </section>
  );
}

function BaseCard({ base, onError }: { base: string; onError: (text: string) => void }) {
  const { t, locale } = useI18n();
  const s = t.shopIntegrations;
  const tag = LOCALE_TAGS[locale];
  const [status, setStatus] = useState<BaseStatus | null>(null);
  const [options, setOptions] = useState<BaseOptions | null>(null);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const [choice, setChoice] = useState({ inventoryId: '', priceGroupId: '', warehouseId: '' });
  const [every, setEvery] = useState(60);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  const load = useCallback(async () => {
    const [st, log] = await Promise.all([
      api<BaseStatus>(base),
      api<{ runs: SyncRun[] }>(`${base}/runs`),
    ]);
    setStatus(st);
    setRuns(log.runs.slice(0, 5));
    setEvery(st.syncEveryMinutes);
  }, [base]);

  useEffect(() => {
    load().catch((e: unknown) => onError(errorText(t, e)));
  }, [load, onError, t]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    onError('');
    setDone('');
    try {
      await action();
      await load();
    } catch (e) {
      onError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const loadOptions = () =>
    run(async () => {
      const got = await api<BaseOptions>(`${base}/options`);
      setOptions(got);
      const inv = got.inventories.find((i) => i.id === status?.inventoryId) ?? got.inventories[0];
      setChoice({
        inventoryId: inv?.id ?? '',
        priceGroupId:
          status?.priceGroupId ??
          got.priceGroups.find((g) => g.matchesSalon && g.id === inv?.defaultPriceGroupId)?.id ??
          got.priceGroups.find((g) => g.matchesSalon)?.id ??
          '',
        warehouseId: status?.warehouseId ?? inv?.defaultWarehouseId ?? got.warehouses[0]?.id ?? '',
      });
      setEditing(true);
    });

  const connect = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(base, { method: 'PUT', body: { token: token.trim() } });
      setToken('');
      const got = await api<BaseOptions>(`${base}/options`);
      setOptions(got);
      const inv = got.inventories[0];
      setChoice({
        inventoryId: inv?.id ?? '',
        priceGroupId:
          got.priceGroups.find((g) => g.matchesSalon && g.id === inv?.defaultPriceGroupId)?.id ??
          got.priceGroups.find((g) => g.matchesSalon)?.id ??
          '',
        warehouseId: inv?.defaultWarehouseId ?? got.warehouses[0]?.id ?? '',
      });
      setEditing(true);
    });
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(base, { method: 'PATCH', body: { ...choice, syncEveryMinutes: every } });
      setEditing(false);
    });
  };

  const showProducts = () =>
    run(async () => {
      const res = await api<{
        products: (Omit<Row, 'key'> & { externalId: string })[];
      }>(`${base}/products`);
      setRows(res.products.map((p) => ({ ...p, key: p.externalId })));
    });

  const importRows = (items: { key: string; online: boolean }[]) =>
    run(async () => {
      const res = await api<ImportResult>(`${base}/import`, {
        method: 'POST',
        body: { items: items.map((i) => ({ externalId: i.key, online: i.online })) },
      });
      setRows(null);
      setDone(importedText(s, res));
    });

  if (!status) return <Spinner />;
  const configured = Boolean(status.inventoryId);
  const inventory = options?.inventories.find((i) => i.id === choice.inventoryId);
  const date = (iso: string) => new Date(iso).toLocaleString(tag);

  return (
    <div className="card stack" data-testid="integration-base">
      <h2>{s.baseTitle}</h2>
      {!status.connected ? (
        <form className="stack" onSubmit={connect}>
          <p className="small muted">{s.baseHint}</p>
          <label className="field">
            <span>{s.token}</span>
            <input
              value={token}
              autoComplete="off"
              spellCheck={false}
              minLength={20}
              maxLength={200}
              required
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <p className="small muted">{s.tokenWhere}</p>
          <div>
            <button type="submit" className="btn" disabled={busy || token.trim().length < 20}>
              {s.connect}
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="small">
            {fill(s.connected, { hint: status.tokenHint ?? '' })}
            {status.inventoryName ? ` · ${s.inventory}: ${status.inventoryName}` : ''}
            {` · ${fill(s.importedCount, { n: String(status.importedProducts) })}`}
          </p>
          {!status.tokenReadable ? <ErrorBox>{t.errors.BASE_RECONNECT}</ErrorBox> : null}
          {status.lastErrorCode ? (
            <p className="small" role="status">
              {s.lastError}:{' '}
              {(t.errors as Record<string, string>)[status.lastErrorCode] ?? t.errors.generic}
            </p>
          ) : null}
          {status.lastSyncAt ? (
            <p className="small muted">
              {fill(s.lastSync, { at: date(status.lastSyncAt) })} ·{' '}
              {fill(s.every, { n: String(status.syncEveryMinutes) })}
            </p>
          ) : null}

          {editing && options ? (
            <form className="stack" onSubmit={save}>
              <label className="field">
                <span>{s.inventory}</span>
                <select
                  value={choice.inventoryId}
                  onChange={(e) => setChoice({ ...choice, inventoryId: e.target.value })}
                >
                  {options.inventories.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{s.priceGroup}</span>
                <select
                  value={choice.priceGroupId}
                  onChange={(e) => setChoice({ ...choice, priceGroupId: e.target.value })}
                >
                  {options.priceGroups
                    .filter(
                      (g) =>
                        g.matchesSalon &&
                        (!inventory?.priceGroupIds.length ||
                          inventory.priceGroupIds.includes(g.id)),
                    )
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name} ({g.currency})
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>{s.warehouse}</span>
                <select
                  value={choice.warehouseId}
                  onChange={(e) => setChoice({ ...choice, warehouseId: e.target.value })}
                >
                  {options.warehouses
                    .filter(
                      (w) =>
                        !inventory?.warehouseIds.length || inventory.warehouseIds.includes(w.id),
                    )
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>{s.syncEvery}</span>
                <select value={every} onChange={(e) => setEvery(Number(e.target.value))}>
                  {SYNC_EVERY.map((n) => (
                    <option key={n} value={n}>
                      {fill(s.minutes, { n: String(n) })}
                    </option>
                  ))}
                </select>
              </label>
              <div className="row">
                <button
                  type="submit"
                  className="btn"
                  disabled={
                    busy || !choice.inventoryId || !choice.priceGroupId || !choice.warehouseId
                  }
                >
                  {t.common.save}
                </button>
                {configured ? (
                  <button
                    type="button"
                    className="btn btn--quiet"
                    onClick={() => setEditing(false)}
                  >
                    {t.common.cancel}
                  </button>
                ) : null}
              </div>
            </form>
          ) : (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {configured ? (
                <>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void showProducts()}
                  >
                    {s.chooseProducts}
                  </button>
                  <button
                    type="button"
                    className="btn btn--quiet"
                    disabled={busy || status.importedProducts === 0}
                    onClick={() => void run(() => api(`${base}/sync`, { method: 'POST' }))}
                  >
                    {s.syncNow}
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="btn btn--quiet"
                disabled={busy}
                onClick={() => void loadOptions()}
              >
                {configured ? s.settings : s.chooseInventory}
              </button>
              <button
                type="button"
                className="link-btn small"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(s.disconnectConfirm)) {
                    void run(() => api(base, { method: 'DELETE' }));
                  }
                }}
              >
                {s.disconnect}
              </button>
            </div>
          )}
        </>
      )}
      {configured && !editing ? (
        <OrdersToBase base={base} orders={status.orders} onSaved={load} onError={onError} />
      ) : null}
      {done ? (
        <p className="small" role="status">
          {done}
        </p>
      ) : null}
      {rows ? (
        <Picker rows={rows} busy={busy} onImport={importRows} onClose={() => setRows(null)} />
      ) : null}
      {runs.length > 0 ? (
        <details>
          <summary className="small">{s.log}</summary>
          <ul className="list small" aria-label={s.log}>
            {runs.map((r) => (
              <li key={r.id}>
                {date(r.startedAt)} · {s.triggers[r.trigger]} ·{' '}
                {r.errorCode
                  ? ((t.errors as Record<string, string>)[r.errorCode] ?? t.errors.generic)
                  : r.trigger === 'orders'
                    ? fill(s.ordersRunLine, {
                        checked: String(r.checked),
                        changed: String(r.changed),
                      })
                    : fill(s.runLine, {
                        checked: String(r.checked),
                        changed: String(r.changed),
                        missing: String(r.missing),
                      })}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Task Q4 (part 5): "Zamówienia do Base" — folded under the Base card. Products put aside for a
 * visit go to the seller's Base as orders; the seller picks the statuses (new, handed over,
 * cancelled) from its own Base.
 */
function OrdersToBase({
  base,
  orders,
  onSaved,
  onError,
}: {
  base: string;
  orders: BaseStatus['orders'];
  onSaved: () => Promise<void>;
  onError: (text: string) => void;
}) {
  const { t } = useI18n();
  const s = t.shopIntegrations;
  const [statuses, setStatuses] = useState<{ id: string; name: string }[] | null>(null);
  const [form, setForm] = useState({
    enabled: orders.enabled,
    newStatusId: orders.newStatusId ?? '',
    handedStatusId: orders.handedStatusId ?? '',
    cancelledStatusId: orders.cancelledStatusId ?? '',
  });
  const [busy, setBusy] = useState(false);

  const open = () => {
    if (statuses) return;
    api<{ statuses: { id: string; name: string }[] }>(`${base}/order-statuses`)
      .then((res) => {
        setStatuses(res.statuses);
        setForm((f) => ({ ...f, newStatusId: f.newStatusId || (res.statuses[0]?.id ?? '') }));
      })
      .catch((e: unknown) => onError(errorText(t, e)));
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    onError('');
    api(`${base}/orders`, {
      method: 'PUT',
      body: {
        enabled: form.enabled,
        newStatusId: form.newStatusId || null,
        handedStatusId: form.handedStatusId || null,
        cancelledStatusId: form.cancelledStatusId || null,
      },
    })
      .then(onSaved)
      .catch((err: unknown) => onError(errorText(t, err)))
      .finally(() => setBusy(false));
  };

  const pick = (key: 'newStatusId' | 'handedStatusId' | 'cancelledStatusId', label: string) => (
    <label className="field">
      <span>{label}</span>
      <select
        value={form[key]}
        required={key === 'newStatusId' && form.enabled}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      >
        {key === 'newStatusId' ? null : <option value="">{s.ordersLeave}</option>}
        {(statuses ?? []).map((st) => (
          <option key={st.id} value={st.id}>
            {st.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <details
      data-testid="integration-base-orders"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) open();
      }}
    >
      <summary className="small">
        {s.ordersTitle}: {orders.enabled ? s.ordersOn : s.ordersOff}
      </summary>
      {orders.failing > 0 ? (
        <p className="small" role="status">
          {fill(s.ordersFailing, { n: String(orders.failing) })}
        </p>
      ) : null}
      {statuses ? (
        <form className="stack" onSubmit={save}>
          <p className="small muted">{s.ordersHint}</p>
          <label className="row small">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <span>{s.ordersEnable}</span>
          </label>
          {form.enabled ? (
            <>
              {pick('newStatusId', s.ordersNew)}
              {pick('handedStatusId', s.ordersHanded)}
              {pick('cancelledStatusId', s.ordersCancelled)}
            </>
          ) : null}
          <div>
            <button type="submit" className="btn" disabled={busy}>
              {t.common.save}
            </button>
          </div>
        </form>
      ) : (
        <Spinner />
      )}
    </details>
  );
}

function FeedCard({ base, onError }: { base: string; onError: (text: string) => void }) {
  const { t } = useI18n();
  const s = t.shopIntegrations;
  const [feed, setFeed] = useState<{ feedId: string; unreadable: number; rows: Row[] } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  const upload = async (file: File) => {
    setBusy(true);
    onError('');
    setDone('');
    try {
      const type =
        /\.xml$/i.test(file.name) || file.type.includes('xml') ? 'application/xml' : 'text/csv';
      const res = await api<{
        feedId: string;
        unreadable: number;
        products: Row[];
      }>(base, { method: 'POST', file: new Blob([file], { type }) });
      setFeed({ feedId: res.feedId, unreadable: res.unreadable, rows: res.products });
    } catch (e) {
      onError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const importRows = async (items: { key: string; online: boolean }[]) => {
    if (!feed) return;
    setBusy(true);
    onError('');
    try {
      const res = await api<ImportResult>(`${base}/${feed.feedId}/import`, {
        method: 'POST',
        body: { items },
      });
      setFeed(null);
      setDone(importedText(s, res));
    } catch (e) {
      onError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack" data-testid="integration-feed">
      <h2>{s.feedTitle}</h2>
      <p className="small muted">{s.feedHint}</p>
      <label className="field">
        <span>{s.file}</span>
        <input
          type="file"
          accept=".csv,.txt,.xml,text/csv,application/xml,text/xml"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = '';
          }}
        />
      </label>
      {busy && !feed ? <Spinner /> : null}
      {done ? (
        <p className="small" role="status">
          {done}
        </p>
      ) : null}
      {feed ? (
        <>
          {feed.unreadable > 0 ? (
            <p className="small muted">{fill(s.unreadable, { n: String(feed.unreadable) })}</p>
          ) : null}
          <Picker
            rows={feed.rows}
            busy={busy}
            onImport={(items) => void importRows(items)}
            onClose={() => setFeed(null)}
          />
        </>
      ) : null}
    </div>
  );
}

/** The seller ticks products; each ticked one is "tylko w salonie" unless "też online" is on. */
function Picker({
  rows,
  busy,
  onImport,
  onClose,
}: {
  rows: Row[];
  busy: boolean;
  onImport: (items: { key: string; online: boolean }[]) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const s = t.shopIntegrations;
  const { location } = useSession();
  const tag = LOCALE_TAGS[locale];
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [online, setOnline] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const importable = rows.filter((r) => r.priceGrosze !== null);
  const words = filter.trim().toLowerCase();
  const shown = words
    ? rows.filter((r) => r.name.toLowerCase().includes(words) || r.ean?.includes(words))
    : rows;
  const chosen = Object.keys(ticked).filter((k) => ticked[k]);

  return (
    <div className="stack" data-testid="integration-picker">
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field">
          <span>{s.filter}</span>
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <button
          type="button"
          className="link-btn small"
          onClick={() =>
            setTicked(Object.fromEntries(importable.map((r) => [r.key, chosen.length === 0])))
          }
        >
          {chosen.length === 0 ? s.tickAll : s.untickAll}
        </button>
      </div>
      <ul className="list" aria-label={s.chooseProducts}>
        {shown.slice(0, 500).map((r) => (
          <li
            key={r.key}
            className="row"
            style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}
          >
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(ticked[r.key])}
                disabled={busy || r.priceGrosze === null}
                onChange={(e) => setTicked({ ...ticked, [r.key]: e.target.checked })}
              />
              <span>
                <strong>{r.name}</strong>
                <span className="muted small">
                  {r.priceGrosze !== null
                    ? ` · ${formatPrice(r.priceGrosze, location.currency, tag)}`
                    : ` · ${s.noPrice}`}
                  {r.stock !== null ? ` · ${fill(s.pieces, { n: String(r.stock) })}` : ''}
                  {r.ean ? ` · EAN ${r.ean}` : ''}
                  {r.importedProductId
                    ? ` · ${s.alreadyHere}`
                    : r.catalogProductId
                      ? ` · ${s.inCatalogue}`
                      : ''}
                </span>
              </span>
            </label>
            {ticked[r.key] ? (
              <label className="check small">
                <input
                  type="checkbox"
                  checked={Boolean(online[r.key])}
                  disabled={busy}
                  onChange={(e) => setOnline({ ...online, [r.key]: e.target.checked })}
                />
                <span>{s.alsoOnline}</span>
              </label>
            ) : null}
          </li>
        ))}
      </ul>
      {shown.length > 500 ? <p className="small muted">{s.narrowDown}</p> : null}
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={busy || chosen.length === 0}
          onClick={() =>
            onImport(chosen.slice(0, 200).map((key) => ({ key, online: Boolean(online[key]) })))
          }
        >
          {fill(s.importTicked, { n: String(Math.min(chosen.length, 200)) })}
        </button>
        <button type="button" className="btn btn--quiet" onClick={onClose}>
          {t.common.cancel}
        </button>
      </div>
    </div>
  );
}
