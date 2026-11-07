'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { calendarErrorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { useSubmitLock } from '@/lib/submit-lock';
import { clockToMinutes, formatDay, formatPrice, minutesToClock, zonedToInstant } from '@/lib/time';
import type { Customer, Service, Staff, TimeBlockSeries } from '@/lib/types';
import { dialForTimeZone, normalizePhone } from '@/lib/phone';
import { PhoneField } from '../PhoneField';
import { useSession } from '../Session';
import { ErrorBox, Sheet } from '../ui';

/** The client a new visit is for, when it is known in advance ("Umów ponownie", task 223). */
export type DraftCustomer = Pick<Customer, 'id' | 'name' | 'phone'>;

export interface NewItemDraft {
  kind: 'appointment' | 'block';
  staffId: string | null;
  date: string;
  minute: number;
  serviceId?: string;
  customer?: DraftCustomer;
}

export function NewItemSheet({
  draft,
  base,
  services,
  staffList,
  onClose,
  onCreated,
}: {
  draft: NewItemDraft;
  base: string;
  services: Service[];
  staffList: Staff[];
  onClose: () => void;
  onCreated: (date: string) => void;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const session = useSession();
  const tz = session.location.timezone;
  const manager = session.role !== 'staff';
  const canBlock = manager || session.permissions.blockOwnTime === true;
  const canOutside = manager || session.permissions.bookOutsideHours === true;
  const canSearchClients = manager;

  const [kind, setKind] = useState(draft.kind === 'block' && canBlock ? 'block' : 'appointment');
  const activeServices = services.filter((s) => s.active);
  const [serviceId, setServiceId] = useState(draft.serviceId ?? '');
  const [staffId, setStaffId] = useState(draft.staffId ?? '');
  const [date, setDate] = useState(draft.date);
  const [time, setTime] = useState(minutesToClock(draft.minute));
  const [endTime, setEndTime] = useState(minutesToClock(Math.min(draft.minute + 60, 1435)));
  const [reason, setReason] = useState('');
  // Launch task L4: the same time every week (e.g. visits still kept in Booksy).
  const [repeat, setRepeat] = useState(false);
  const [weeks, setWeeks] = useState(8);
  const [skipped, setSkipped] = useState<{ count: number; dates: string[] } | null>(null);
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<DraftCustomer | null>(draft.customer ?? null);
  const dial = dialForTimeZone(session.location.timezone);
  const [fresh, setFresh] = useState({ name: '', phone: `+${dial} `, email: '' });
  const [outside, setOutside] = useState(false);
  const [askOutside, setAskOutside] = useState(false);
  const [paidNow, setPaidNow] = useState(false);
  const [error, setError] = useState('');
  const { busy, lock, unlock } = useSubmitLock();
  // One key per form: a retry after a dropped connection does not book twice.
  const [key] = useState(newIdempotencyKey);

  const staffForService = useMemo(
    () => staffList.filter((s) => s.active && (!serviceId || s.serviceIds.includes(serviceId))),
    [staffList, serviceId],
  );

  useEffect(() => {
    if (!canSearchClients || search.trim().length < 2) {
      setFound([]);
      return;
    }
    const timer = window.setTimeout(() => {
      api<Customer[]>(`/v1/organizations/${session.orgId}/customers`, {
        query: { search: search.trim(), limit: 8 },
      })
        .then(setFound)
        .catch(() => setFound([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, canSearchClients, session.orgId]);

  // A time that has passed: a walk-in entered afterwards, saved straight away as "came".
  const startMs = date && time ? zonedToInstant(date, clockToMinutes(time), tz) : NaN;
  const inPast = kind === 'appointment' && startMs < Date.now();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!lock()) return;
    setError('');
    const start = new Date(zonedToInstant(date, clockToMinutes(time), tz)).toISOString();
    try {
      if (kind === 'block') {
        const end = new Date(zonedToInstant(date, clockToMinutes(endTime), tz)).toISOString();
        const body = { staffId: staffId || null, start, end, reason: reason || undefined };
        if (repeat) {
          const made = await api<TimeBlockSeries>(`${base}/time-blocks/series`, {
            method: 'POST',
            idempotencyKey: key,
            body: { ...body, weeks },
          });
          if (made.skippedDates.length > 0) {
            setSkipped({ count: made.items.length, dates: made.skippedDates });
            return;
          }
        } else {
          await api(`${base}/time-blocks`, { method: 'POST', idempotencyKey: key, body });
        }
      } else {
        await api(`${base}/appointments`, {
          method: 'POST',
          idempotencyKey: key,
          body: {
            serviceId,
            staffId,
            start,
            ...(customer
              ? { customerId: customer.id }
              : {
                  customer: {
                    name: fresh.name,
                    phone: normalizePhone(fresh.phone, dial),
                    ...(fresh.email ? { email: fresh.email } : {}),
                    locale,
                  },
                }),
            note: note || undefined,
            ...(inPast ? { alreadyHappened: true, paid: paidNow } : { allowOutsideHours: outside }),
          },
        });
      }
      onCreated(date);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OUTSIDE_WORKING_HOURS' && canOutside) {
        setAskOutside(true);
      }
      setError(calendarErrorText(t, err));
      unlock();
    }
  }

  return (
    <Sheet
      title={kind === 'block' ? t.calendar.blockTime : t.calendar.newAppointment}
      onClose={onClose}
    >
      {canBlock ? (
        <div className="tabs" role="group">
          <button
            type="button"
            aria-pressed={kind === 'appointment'}
            onClick={() => setKind('appointment')}
          >
            {t.calendar.newAppointment}
          </button>
          <button type="button" aria-pressed={kind === 'block'} onClick={() => setKind('block')}>
            {t.calendar.blockTime}
          </button>
        </div>
      ) : null}

      <form className="form" onSubmit={submit}>
        <ErrorBox>{error}</ErrorBox>

        {kind === 'appointment' ? (
          <label className="field">
            <span>{t.appointment.service}</span>
            <select required value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="" disabled>
                {t.appointment.chooseService}
              </option>
              {activeServices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.durationMinutes} {t.common.minutes} ·{' '}
                  {formatPrice(s.priceGrosze, session.location.currency, tag)}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="field">
          <span>{t.appointment.staff}</span>
          <select
            required={kind === 'appointment'}
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
          >
            {kind === 'block' && manager ? (
              <option value="">{t.calendar.wholeSalon}</option>
            ) : (
              <option value="" disabled>
                {t.appointment.chooseStaff}
              </option>
            )}
            {(kind === 'appointment' ? staffForService : staffList.filter((s) => s.active)).map(
              (s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ),
            )}
          </select>
        </label>

        <div className="row">
          <label className="field">
            <span>{t.appointment.date}</span>
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span>{kind === 'block' ? t.appointment.from : t.appointment.time}</span>
            <input
              type="time"
              step={300}
              required
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
          {kind === 'block' ? (
            <label className="field">
              <span>{t.appointment.to}</span>
              <input
                type="time"
                step={300}
                required
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </label>
          ) : null}
        </div>

        {kind === 'block' ? (
          <>
            <label className="field">
              <span>{t.appointment.blockReason}</span>
              <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={repeat}
                onChange={(e) => setRepeat(e.target.checked)}
              />
              <span>{t.appointment.repeatWeekly}</span>
            </label>
            {repeat ? (
              <label className="field">
                <span>{t.appointment.repeatWeeks}</span>
                <input
                  type="number"
                  min={2}
                  max={26}
                  required
                  value={weeks}
                  onChange={(e) => setWeeks(Number(e.target.value))}
                />
                <span className="small muted">{t.appointment.repeatHint}</span>
              </label>
            ) : null}
            {skipped ? (
              <div className="note" role="status">
                <p>
                  {fill(t.appointment.skippedWeeks, {
                    count: String(skipped.count),
                    dates: skipped.dates.map((d) => formatDay(d, LOCALE_TAGS[locale])).join(', '),
                  })}
                </p>
                <button type="button" className="btn" onClick={() => onCreated(date)}>
                  {t.appointment.done}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <>
            {canSearchClients && !customer ? (
              <div className="field">
                <label className="field">
                  <span>{t.appointment.findClient}</span>
                  <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
                </label>
                {found.length ? (
                  <div className="list-pick">
                    {found.map((c) => (
                      <button key={c.id} type="button" onClick={() => setCustomer(c)}>
                        <strong>{c.name}</strong>
                        <span className="muted small"> {c.phone ?? c.email ?? ''}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {customer ? (
              <div className="note row" style={{ alignItems: 'center' }}>
                <span>
                  <strong>{customer.name}</strong>{' '}
                  <span className="muted">{customer.phone ?? ''}</span>
                </span>
                <button type="button" className="link-btn" onClick={() => setCustomer(null)}>
                  {t.common.cancel}
                </button>
              </div>
            ) : (
              <fieldset className="form" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="small muted" style={{ marginBottom: 8 }}>
                  {t.appointment.newClient}
                </legend>
                <label className="field">
                  <span>{t.appointment.name}</span>
                  <input
                    required
                    value={fresh.name}
                    onChange={(e) => setFresh({ ...fresh, name: e.target.value })}
                  />
                </label>
                <div className="row">
                  <PhoneField
                    label={t.appointment.phone}
                    required
                    value={fresh.phone}
                    defaultDial={dial}
                    onChange={(phone) => setFresh({ ...fresh, phone })}
                  />
                  <label className="field">
                    <span>
                      {t.appointment.email} ({t.common.optional})
                    </span>
                    <input
                      type="email"
                      value={fresh.email}
                      onChange={(e) => setFresh({ ...fresh, email: e.target.value })}
                    />
                  </label>
                </div>
              </fieldset>
            )}

            <label className="field">
              <span>
                {t.appointment.note} ({t.common.optional})
              </span>
              <textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </label>

            {inPast ? (
              <>
                <p className="note small" data-testid="walk-in-note">
                  {t.appointment.walkInNote}
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={paidNow}
                    onChange={(e) => setPaidNow(e.target.checked)}
                  />
                  <span>{t.appointment.walkInPaid}</span>
                </label>
              </>
            ) : null}

            {askOutside && !inPast ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={outside}
                  onChange={(e) => setOutside(e.target.checked)}
                />
                <span>{t.appointment.outsideHours}</span>
              </label>
            ) : null}
          </>
        )}

        <button className="btn btn--block" disabled={busy}>
          {kind === 'block' ? t.appointment.createBlock : t.appointment.create}
        </button>
      </form>
    </Sheet>
  );
}
