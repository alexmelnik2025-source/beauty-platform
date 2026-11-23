'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { calendarErrorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { useSubmitLock } from '@/lib/submit-lock';
import { clockToMinutes, formatDay, formatPrice, minutesToClock, zonedToInstant } from '@/lib/time';
import type { Customer, PaymentMethod, Service, Staff, TimeBlockSeries } from '@/lib/types';
import { dialForTimeZone, normalizePhone } from '@/lib/phone';
import { EMAIL_SHAPE, PHONE_SHAPE } from '@/lib/contact-check';
import { PhoneField } from '../PhoneField';
import { useSession } from '../Session';
import { ErrorBox, FieldError, Sheet } from '../ui';
import { PaymentMethodPicker } from './PaymentMethodPicker';

/**
 * Task 672: the fields of a new visit or a blocked time that can show an error under them;
 * task 694 added the ones the browser used to check with its bubble.
 */
type ItemField =
  | 'service'
  | 'staff'
  | 'date'
  | 'time'
  | 'endTime'
  | 'weeks'
  | 'name'
  | 'phone'
  | 'email'
  | 'outside';

/** Which new-client field the server's answer is about; null when it is about something else. */
function itemFieldOf(err: unknown): 'name' | 'phone' | 'email' | null {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return null;
  if (!Array.isArray(err.details)) return null;
  const paths = (err.details as { path?: string }[]).map((d) => d.path);
  const fields = ['name', 'phone', 'email'] as const;
  return fields.find((f) => paths.includes(`customer.${f}`)) ?? null;
}

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
  /** Task 227: how the walk-in paid (optional). */
  const [paidWith, setPaidWith] = useState<PaymentMethod | null>(null);
  const [error, setError] = useState('');
  /**
   * Task 672 (owner's rule: errors at the field): "Do" before "Od", a blank name, a wrong phone or
   * e-mail are said under their own field, which gets the cursor; editing it takes the error away.
   */
  const [problem, setProblem] = useState<{ field: ItemField; text: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const { busy, lock, unlock } = useSubmitLock();

  useEffect(() => {
    if (!problem) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [problem]);
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
    setError('');
    setProblem(null);
    const found = localProblem();
    if (found) {
      setProblem(found);
      return;
    }
    if (!lock()) return;
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
            ...(inPast
              ? {
                  alreadyHappened: true,
                  paid: paidNow,
                  ...(paidNow && paidWith ? { paymentMethod: paidWith } : {}),
                }
              : { allowOutsideHours: outside }),
          },
        });
      }
      onCreated(date);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OUTSIDE_WORKING_HOURS') {
        // Task 723 (owner's rule: errors at the field): said under "Zapisz także poza godzinami
        // pracy" for those allowed to tick it, otherwise under the time — not as a line at the top.
        const tick = canOutside && kind === 'appointment' && !inPast;
        if (tick) setAskOutside(true);
        setProblem({ field: tick ? 'outside' : 'time', text: calendarErrorText(t, err) });
        unlock();
        return;
      }
      const field = kind === 'appointment' && !customer ? itemFieldOf(err) : null;
      const text: Record<'name' | 'phone' | 'email', string> = {
        name: t.onboarding.fieldRequired,
        phone: t.booking.phoneInvalid,
        email: t.booking.emailInvalid,
      };
      if (field) setProblem({ field, text: text[field] });
      else setError(calendarErrorText(t, err));
      unlock();
    }
  }

  /**
   * Task 694 (owner's rule: errors at the field): the form has no browser checks (they showed a
   * bubble), so the first empty or wrong field, in the order of the form, is said under it.
   */
  function localProblem(): { field: ItemField; text: string } | null {
    const required = t.onboarding.fieldRequired;
    const appointment = kind === 'appointment';
    if (appointment && !serviceId) return { field: 'service', text: required };
    if (appointment && !staffId) return { field: 'staff', text: required };
    if (!date) return { field: 'date', text: required };
    if (!time) return { field: 'time', text: required };
    if (!appointment) {
      if (!endTime) return { field: 'endTime', text: required };
      if (clockToMinutes(endTime) <= clockToMinutes(time)) {
        return { field: 'endTime', text: t.team.specialBadTime };
      }
      if (repeat && !(Number.isInteger(weeks) && weeks >= 2 && weeks <= 26)) {
        return { field: 'weeks', text: fill(t.guard.numberRange, { min: '2', max: '26' }) };
      }
      return null;
    }
    if (customer) return null;
    if (!fresh.name.trim()) return { field: 'name', text: required };
    if (!PHONE_SHAPE.test(normalizePhone(fresh.phone, dial).replace(/[\s()-]/g, ''))) {
      return { field: 'phone', text: t.booking.phoneInvalid };
    }
    if (fresh.email.trim() && !EMAIL_SHAPE.test(fresh.email.trim())) {
      return { field: 'email', text: t.booking.emailInvalid };
    }
    return null;
  }

  /** Editing a field takes its error away. */
  const clear = (field: ItemField) => {
    if (problem?.field === field) setProblem(null);
  };
  const invalid = (field: ItemField) => ({
    'aria-invalid': problem?.field === field || undefined,
    'aria-describedby': problem?.field === field ? `new-item-${field}-error` : undefined,
  });
  const fieldError = (field: ItemField) => (
    <FieldError
      id={`new-item-${field}-error`}
      text={problem?.field === field ? problem.text : undefined}
    />
  );

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

      <form noValidate className="form" ref={formRef} onSubmit={submit}>
        <ErrorBox>{error}</ErrorBox>

        {kind === 'appointment' ? (
          <label className="field">
            <span>{t.appointment.service}</span>
            <select
              required
              value={serviceId}
              {...invalid('service')}
              onChange={(e) => {
                setServiceId(e.target.value);
                clear('service');
              }}
            >
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
            {fieldError('service')}
          </label>
        ) : null}

        <label className="field">
          <span>{t.appointment.staff}</span>
          <select
            required={kind === 'appointment'}
            value={staffId}
            {...invalid('staff')}
            onChange={(e) => {
              setStaffId(e.target.value);
              clear('staff');
            }}
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
          {fieldError('staff')}
        </label>

        <div className="row">
          <label className="field">
            <span>{t.appointment.date}</span>
            <input
              type="date"
              required
              value={date}
              {...invalid('date')}
              onChange={(e) => {
                setDate(e.target.value);
                clear('date');
              }}
            />
            {fieldError('date')}
          </label>
          <label className="field">
            <span>{kind === 'block' ? t.appointment.from : t.appointment.time}</span>
            <input
              type="time"
              step={300}
              required
              value={time}
              {...invalid('time')}
              onChange={(e) => {
                setTime(e.target.value);
                clear('time');
                clear('endTime');
              }}
            />
            {fieldError('time')}
          </label>
          {kind === 'block' ? (
            <label className="field">
              <span>{t.appointment.to}</span>
              <input
                type="time"
                step={300}
                required
                value={endTime}
                {...invalid('endTime')}
                onChange={(e) => {
                  setEndTime(e.target.value);
                  clear('endTime');
                }}
              />
              {fieldError('endTime')}
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
                  {...invalid('weeks')}
                  onChange={(e) => {
                    setWeeks(Number(e.target.value));
                    clear('weeks');
                  }}
                />
                {fieldError('weeks')}
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
                    {...invalid('name')}
                    onChange={(e) => {
                      setFresh({ ...fresh, name: e.target.value });
                      clear('name');
                    }}
                  />
                  {fieldError('name')}
                </label>
                <div className="row">
                  <PhoneField
                    label={t.appointment.phone}
                    required
                    value={fresh.phone}
                    defaultDial={dial}
                    error={problem?.field === 'phone' ? problem.text : undefined}
                    onChange={(phone) => {
                      setFresh({ ...fresh, phone });
                      clear('phone');
                    }}
                  />
                  <label className="field">
                    <span>
                      {t.appointment.email} ({t.common.optional})
                    </span>
                    <input
                      type="email"
                      value={fresh.email}
                      {...invalid('email')}
                      onChange={(e) => {
                        setFresh({ ...fresh, email: e.target.value });
                        clear('email');
                      }}
                    />
                    {fieldError('email')}
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
                {paidNow ? <PaymentMethodPicker value={paidWith} onChange={setPaidWith} /> : null}
              </>
            ) : null}

            {askOutside && !inPast ? (
              <div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={outside}
                    {...invalid('outside')}
                    onChange={(e) => {
                      setOutside(e.target.checked);
                      clear('outside');
                    }}
                  />
                  <span>{t.appointment.outsideHours}</span>
                </label>
                {fieldError('outside')}
              </div>
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
