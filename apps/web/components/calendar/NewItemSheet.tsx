'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { clockToMinutes, formatPrice, minutesToClock, zonedToInstant } from '@/lib/time';
import type { Customer, Service, Staff } from '@/lib/types';
import { useSession } from '../Session';
import { ErrorBox, Sheet } from '../ui';

export interface NewItemDraft {
  kind: 'appointment' | 'block';
  staffId: string | null;
  date: string;
  minute: number;
}

/** "600 100 200" → "+48600100200"; anything starting with + is kept. */
export function normalizePhone(value: string): string {
  const compact = value.replace(/[\s()-]/g, '');
  if (compact.startsWith('+')) return compact;
  if (compact.startsWith('00')) return `+${compact.slice(2)}`;
  return /^\d{9}$/.test(compact) ? `+48${compact}` : compact;
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
  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState(draft.staffId ?? '');
  const [date, setDate] = useState(draft.date);
  const [time, setTime] = useState(minutesToClock(draft.minute));
  const [endTime, setEndTime] = useState(minutesToClock(Math.min(draft.minute + 60, 1435)));
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [fresh, setFresh] = useState({ name: '', phone: '+48 ', email: '' });
  const [outside, setOutside] = useState(false);
  const [askOutside, setAskOutside] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const start = new Date(zonedToInstant(date, clockToMinutes(time), tz)).toISOString();
    try {
      if (kind === 'block') {
        const end = new Date(zonedToInstant(date, clockToMinutes(endTime), tz)).toISOString();
        await api(`${base}/time-blocks`, {
          method: 'POST',
          idempotencyKey: key,
          body: { staffId: staffId || null, start, end, reason: reason || undefined },
        });
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
                    phone: normalizePhone(fresh.phone),
                    ...(fresh.email ? { email: fresh.email } : {}),
                    locale,
                  },
                }),
            note: note || undefined,
            allowOutsideHours: outside,
          },
        });
      }
      onCreated(date);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OUTSIDE_WORKING_HOURS' && canOutside) {
        setAskOutside(true);
      }
      setError(errorText(t, err));
      setBusy(false);
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
                  {formatPrice(s.priceGrosze, tag)}
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
          <label className="field">
            <span>{t.appointment.blockReason}</span>
            <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
          </label>
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
                  <label className="field">
                    <span>{t.appointment.phone}</span>
                    <input
                      type="tel"
                      required
                      value={fresh.phone}
                      onChange={(e) => setFresh({ ...fresh, phone: e.target.value })}
                    />
                  </label>
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

            {askOutside ? (
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
