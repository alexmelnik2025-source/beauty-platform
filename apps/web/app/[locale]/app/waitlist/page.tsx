'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageTitleHelp } from '@/components/PageTitleHelp';
import { useSession } from '@/components/Session';
import { ErrorBox, FieldError, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatDay } from '@/lib/time';
import type { SalonWaitlistEntry, SalonWaitlist } from '@/lib/types';
import { useSubmitLock } from '@/lib/submit-lock';

/** "4 lis, 14:05" in the salon's time zone. */
function when(iso: string, tag: string, timeZone: string): string {
  return new Intl.DateTimeFormat(tag, {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/**
 * Task 50c: "Lista oczekujących" — clients waiting for a time on a full day, by day, with
 * their contacts (owner and manager only; the server checks it too). "Usuń z listy" removes a
 * client without a message. Clients are told about a freed time automatically (task 50).
 */
export default function WaitingListPage() {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const { orgId, location } = useSession();
  const base = `/v1/organizations/${orgId}/locations/${location.id}`;
  const [items, setItems] = useState<SalonWaitlistEntry[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  // Task 729 (owner's rule: errors where the action is): a refused "Tak, usuń" is said under
  // that client's row, not as a line at the top of the page.
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const { busy, lock, unlock } = useSubmitLock();

  const load = useCallback(async () => {
    try {
      const list = await api<SalonWaitlist>(`${base}/waitlist`);
      setItems(list.items);
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [base, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(entry: SalonWaitlistEntry) {
    if (!lock()) return;
    setRowError(null);
    setInfo('');
    try {
      await api(`${base}/waitlist/${entry.id}/remove`, { method: 'POST' });
      setItems((list) => (list ?? []).filter((e) => e.id !== entry.id));
      setInfo(fill(t.waitingList.removed, { name: entry.name }));
    } catch (err) {
      // Already gone (removed on another device, or the client left the list): show the list as it is now.
      if (err instanceof ApiError && err.code === 'NOT_FOUND') await load();
      else setRowError({ id: entry.id, text: errorText(t, err) });
    } finally {
      setConfirm(null);
      unlock();
    }
  }

  const days = new Map<string, SalonWaitlistEntry[]>();
  for (const e of items ?? []) days.set(e.date, [...(days.get(e.date) ?? []), e]);

  return (
    <>
      <PageTitleHelp id="waitlist-help" title={t.waitingList.title} help={t.waitingList.hint} />
      <div className="page">
        <ErrorBox>{error}</ErrorBox>
        {info ? (
          <p className="note" role="status">
            {info}
          </p>
        ) : null}
        {items === null ? (
          error ? null : (
            <Spinner />
          )
        ) : items.length === 0 ? (
          <p className="note">{t.waitingList.empty}</p>
        ) : (
          [...days].map(([date, entries]) => (
            <section key={date} className="section" aria-label={formatDay(date, tag)}>
              <h2>{formatDay(date, tag)}</h2>
              <ul className="list">
                {entries.map((e) => (
                  <li
                    key={e.id}
                    className={`list-row${rowError?.id === e.id ? ' list-row--error' : ''}`}
                  >
                    <span className="grow">
                      <strong>{e.name}</strong>
                      <span className="small">
                        {e.serviceName} · {e.staffName ?? t.waitingList.anyStaff}
                      </span>
                      <span className="small">
                        <a href={`mailto:${e.email}`}>{e.email}</a>
                        {e.phone ? (
                          <>
                            {' · '}
                            <a href={`tel:${e.phone}`}>{e.phone}</a>
                          </>
                        ) : null}
                      </span>
                      <span className="small muted">
                        {(e.status === 'notified' || e.status === 'offered') && e.notifiedAt
                          ? fill(
                              e.status === 'offered'
                                ? t.waitingList.offered
                                : t.waitingList.notified,
                              { time: when(e.notifiedAt, tag, location.timezone) },
                            )
                          : t.waitingList.waiting}
                        {/* Task Q8: the first free time is booked for this client at once. */}
                        {e.autoBook ? ` · ${t.waitingList.auto}` : null}
                        {' · '}
                        {fill(t.waitingList.askedAt, {
                          time: when(e.createdAt, tag, location.timezone),
                        })}
                      </span>
                    </span>
                    {confirm === e.id ? (
                      <span
                        className="row"
                        role="group"
                        aria-label={fill(t.waitingList.removeAsk, { name: e.name })}
                      >
                        <span className="small">
                          {fill(t.waitingList.removeAsk, { name: e.name })}
                        </span>
                        <button
                          type="button"
                          className="btn btn--danger btn--small"
                          disabled={busy}
                          onClick={() => void remove(e)}
                        >
                          {t.waitingList.removeYes}
                        </button>
                        <button
                          type="button"
                          className="btn btn--quiet btn--small"
                          onClick={() => setConfirm(null)}
                        >
                          {t.waitingList.removeNo}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="link-btn small"
                        aria-label={fill(t.waitingList.removeOne, { name: e.name })}
                        aria-describedby={
                          rowError?.id === e.id ? `waitlist-row-error-${e.id}` : undefined
                        }
                        onClick={() => {
                          setInfo('');
                          setRowError(null);
                          setConfirm(e.id);
                        }}
                      >
                        {t.waitingList.remove}
                      </button>
                    )}
                    {rowError?.id === e.id ? (
                      <FieldError id={`waitlist-row-error-${e.id}`} text={rowError.text} />
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </>
  );
}
