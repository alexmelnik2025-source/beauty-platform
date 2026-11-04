'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AuditLog } from '@beauty/api-client';
import { useSession } from '@/components/Session';
import { ErrorBox, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatDay } from '@/lib/time';

type Entry = AuditLog['items'][number];

/**
 * Task 23: "Dziennik zmian" (owner only) — who changed services, the team, schedules,
 * permissions, clients, loyalty and settings, and when. Newest first, 50 at a time.
 */
export default function HistoryPage() {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const { orgId, location } = useSession();
  const [items, setItems] = useState<Entry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (before?: string) => {
      setBusy(true);
      try {
        const page = await api<AuditLog>(`/v1/organizations/${orgId}/audit-log`, {
          query: { limit: 50, ...(before ? { before } : {}) },
        });
        setItems((prev) => (before && prev ? [...prev, ...page.items] : page.items));
        setNext(page.next);
      } catch (err) {
        setError(errorText(t, err));
      } finally {
        setBusy(false);
      }
    },
    [orgId, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const when = new Intl.DateTimeFormat(tag, {
    timeZone: location.timezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const actions = t.history.actions;

  return (
    <>
      <div className="page-head">
        <h1>{t.history.title}</h1>
      </div>
      <div className="page">
        <p className="small muted">{t.history.hint}</p>
        <ErrorBox>{error}</ErrorBox>
        {items === null ? (
          error ? null : (
            <Spinner />
          )
        ) : items.length === 0 ? (
          <p className="note">{t.history.empty}</p>
        ) : (
          <ul className="list history-log">
            {items.map((e) => (
              <li key={e.id} className="list-row">
                <span className="grow">
                  <strong>
                    {actions[e.action] ?? e.action}
                    {e.entityName ? `: ${e.entityName}` : ''}
                  </strong>
                  <span className="small muted">
                    {e.actor?.name ?? t.history.system} · {when.format(new Date(e.at))}
                    {e.date
                      ? ` · ${fill(t.history.day, { date: formatDay(e.date, tag, { short: true }) })}`
                      : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {next ? (
          <button
            type="button"
            className="btn btn--quiet btn--block"
            disabled={busy}
            onClick={() => void load(next)}
          >
            {t.history.more}
          </button>
        ) : null}
      </div>
    </>
  );
}
