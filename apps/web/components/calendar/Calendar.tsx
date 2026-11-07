'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { api, apiResponse } from '@/lib/api';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import {
  addDays,
  clockToMinutes,
  formatDay,
  minutesToClock,
  toLocal,
  todayIn,
  weekdayShort,
} from '@/lib/time';
import type { Appointment, Calendar as CalendarData, Service, Staff, TimeBlock } from '@/lib/types';
import { useSession } from '../Session';
import { ErrorBox, initials, Spinner } from '../ui';
import { AppointmentSheet } from './AppointmentSheet';
import { BlockSheet } from './BlockSheet';
import { MoveSheet, type MoveTarget } from './MoveSheet';
import { NewItemSheet, type NewItemDraft } from './NewItemSheet';
import { TillReminder } from './TillReminder';
import { TillStrip } from './TillStrip';

const REFRESH_MS = 30_000;
const HOUR_PX = 80;
/** How far (px) the mouse must travel before a press on a visit becomes a drag (task 221). */
const DRAG_START_PX = 6;

/** A visit being dragged: where it was grabbed and where it would land now. */
interface Drag {
  appointment: Appointment;
  /** Minutes between the visit's start and the point it was grabbed at. */
  grabMinutes: number;
  x: number;
  y: number;
  moved: boolean;
  staffId: string;
  /** The day of the column it would land in (another day in the week view, task 222). */
  date: string;
  minute: number;
}

/** Monday of the week that contains `date`. */
function weekStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return addDays(date, 1 - weekday);
}

export function Calendar() {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const session = useSession();
  const { orgId, location } = session;
  const tz = location.timezone;
  const base = `/v1/organizations/${orgId}/locations/${location.id}`;

  // ?date=YYYY-MM-DD opens a given day (links from notifications and emails).
  const [date, setDate] = useState(() => {
    const wanted =
      typeof window === 'undefined'
        ? null
        : new URLSearchParams(window.location.search).get('date');
    return wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : todayIn(tz);
  });
  const [data, setData] = useState<CalendarData | null>(null);
  const [error, setError] = useState('');
  const [services, setServices] = useState<Service[]>([]);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [showCancelled, setShowCancelled] = useState(false);
  // Task 222: "Tydzień" — one specialist's week, a column per day.
  const [mode, setMode] = useState<'day' | 'week'>('day');
  const [weekStaffId, setWeekStaffId] = useState<string | null>(null);
  const [openAppointment, setOpenAppointment] = useState<string | null>(null);
  const [openBlock, setOpenBlock] = useState<TimeBlock | null>(null);
  const [draft, setDraft] = useState<NewItemDraft | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const dragRef = useRef<Drag | null>(null);
  /** The click that ends a drag must not also open the visit card. */
  const justDragged = useRef(false);
  const grid = useRef<HTMLDivElement>(null);
  // Task 221: owners and managers move any visit; a specialist only their own, in their own
  // column, and only with "change own visits". The server checks the same again.
  const manager = session.role !== 'staff';
  const canDrag = manager || session.permissions.changeOwnAppointments === true;
  const canOutside = manager || session.permissions.bookOutsideHours === true;
  /** Task 228: "Kasa dnia" for those who see the salon's (or their own) earnings. */
  const canSeeTill = manager || session.permissions.viewOwnEarnings === true;
  const [now, setNow] = useState(() => Date.now());
  const today = todayIn(tz);
  const monday = weekStart(date);
  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const etag = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);

  const load = useCallback(
    async (fresh = false) => {
      if (fresh) etag.current = null;
      try {
        const res = await apiResponse(`${base}/calendar`, {
          query:
            mode === 'week' ? { from: monday, to: addDays(monday, 6) } : { from: date, to: date },
          headers: etag.current ? { 'If-None-Match': etag.current } : {},
        });
        if (res.status === 304) return;
        etag.current = res.headers.get('ETag');
        setData((await res.json()) as CalendarData);
        setError('');
      } catch (err) {
        setError(errorText(t, err));
      }
    },
    [base, date, mode, monday, t],
  );

  useEffect(() => {
    setData(null);
    void load(true);
  }, [load]);

  // Refresh every 30 s while the tab is visible, and right away when it becomes visible.
  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
      if (document.visibilityState === 'visible') void load();
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);

  useEffect(() => {
    void api<Service[]>(`${base}/services`)
      .then(setServices)
      .catch(() => setServices([]));
    void api<Staff[]>(`${base}/staff`)
      .then(setStaffList)
      .catch(() => setStaffList([]));
  }, [base]);

  const colors = useMemo(
    () => new Map(services.map((s) => [s.id, s.color ?? '#000000'])),
    [services],
  );

  // The specialist whose week is shown: the chosen one, else the first in the calendar.
  const weekStaff =
    data?.staff.find((s) => s.id === weekStaffId) ?? (mode === 'week' ? data?.staff[0] : undefined);

  const view = useMemo(() => {
    if (!data) return null;
    // Day: a column per specialist. Week (task 222): a column per day of one specialist.
    const columns =
      mode === 'week' && weekStaff
        ? week.map((d) => ({ key: d, staff: weekStaff, date: d }))
        : data.staff.map((s) => ({ key: s.id, staff: s, date }));
    const dates = new Set(columns.map((c) => c.date));
    const appointments = data.appointments.filter(
      (a) =>
        dates.has(a.date) &&
        (mode === 'day' || a.staff.id === weekStaff?.id) &&
        (showCancelled || a.status !== 'cancelled'),
    );
    const blocks = data.blocks.filter((b) => !b.deleted);
    // Visible hours: everyone's working time plus anything booked outside it.
    let first = Infinity;
    let last = -Infinity;
    for (const c of columns) {
      for (const i of c.staff.days.find((d) => d.date === c.date)?.intervals ?? []) {
        first = Math.min(first, clockToMinutes(i.start));
        last = Math.max(last, clockToMinutes(i.end));
      }
    }
    for (const a of appointments) {
      const start = clockToMinutes(a.time);
      first = Math.min(first, start);
      last = Math.max(last, start + a.durationMinutes);
    }
    if (!Number.isFinite(first)) {
      first = 9 * 60;
      last = 18 * 60;
    }
    const startMin = Math.max(0, Math.floor(first / 60) * 60 - 60);
    const endMin = Math.min(24 * 60, Math.ceil(last / 60) * 60 + 60);
    return { columns, appointments, blocks, startMin, endMin };
  }, [data, date, showCancelled, mode, week, weekStaff]);

  const px = (minutes: number) => ((minutes - (view?.startMin ?? 0)) / 60) * HOUR_PX;

  // Once per day shown: scroll to the current time (today) or to the first visit.
  useEffect(() => {
    const key = `${location.id}:${mode}:${mode === 'week' ? monday : date}`;
    if (!view || !scroller.current || scrolledFor.current === key) return;
    scrolledFor.current = key;
    const nowLocal = toLocal(Date.now(), tz);
    const first = view.appointments.map((a) => clockToMinutes(a.time)).sort((x, y) => x - y)[0];
    const showsToday = view.columns.some((c) => c.date === nowLocal.date);
    const target = showsToday ? nowLocal.minute : (first ?? view.startMin + 60);
    scroller.current.scrollTop = Math.max(0, ((target - view.startMin) / 60) * HOUR_PX - HOUR_PX);
  }, [view, date, monday, mode, location.id, tz]);

  /** Minutes of an ISO instant within the column's day (clipped to the day). */
  const dayMinute = (iso: string, day: string) => {
    const local = toLocal(iso, tz);
    if (local.date < day) return 0;
    if (local.date > day) return 24 * 60;
    return local.minute;
  };

  function openNew(staffId: string, day: string, minute: number) {
    setDraft({ kind: 'appointment', staffId, date: day, minute });
  }

  // Task 221: drag a visit with the mouse to another time or specialist. Touch screens keep
  // scrolling the calendar; there the visit card's "Przenieś" does the same.
  function startDrag(e: ReactPointerEvent<HTMLButtonElement>, a: Appointment) {
    if (!canDrag || a.status !== 'confirmed' || e.pointerType === 'touch' || e.button !== 0) {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      appointment: a,
      grabMinutes: ((e.clientY - rect.top) / HOUR_PX) * 60,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      staffId: a.staff.id,
      date: a.date,
      minute: clockToMinutes(a.time),
    };
  }

  function moveDrag(e: ReactPointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d || !view || !grid.current || !data) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_START_PX) return;
    const cols = Array.from(grid.current.querySelectorAll<HTMLElement>('[data-staff-col]'));
    if (cols.length === 0) return;
    let col =
      cols.find((c) => c.dataset.staffCol === d.staffId && c.dataset.colDate === d.date) ??
      cols[0]!;
    // Another specialist (owner, manager) or, in one specialist's week, another day.
    if (manager || mode === 'week') {
      col =
        cols.find((c) => {
          const r = c.getBoundingClientRect();
          return e.clientX >= r.left && e.clientX < r.right;
        }) ?? col;
    }
    const top = col.getBoundingClientRect().top;
    const step = data.location.slotStepMinutes || 15;
    const raw = view.startMin + ((e.clientY - top) / HOUR_PX) * 60 - d.grabMinutes;
    const latest = 24 * 60 - d.appointment.durationMinutes;
    const minute = Math.min(latest, Math.max(0, Math.round(raw / step) * step));
    const next = {
      ...d,
      moved: true,
      staffId: col.dataset.staffCol ?? d.staffId,
      date: col.dataset.colDate ?? d.date,
      minute,
    };
    dragRef.current = next;
    setDrag(next);
  }

  function endDrag(cancelled: boolean) {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d?.moved) return;
    justDragged.current = true;
    window.setTimeout(() => {
      justDragged.current = false;
    }, 0);
    const a = d.appointment;
    const same =
      d.staffId === a.staff.id && d.date === a.date && d.minute === clockToMinutes(a.time);
    if (cancelled || same) return;
    setMoveTarget({ appointment: a, date: d.date, staffId: d.staffId, minute: d.minute });
  }

  if (error && !data) {
    return (
      <div className="page-head">
        <ErrorBox>{error}</ErrorBox>
      </div>
    );
  }

  return (
    <>
      <div className="cal-toolbar">
        <div className="date-title">
          <strong>
            {mode === 'week'
              ? `${formatDay(monday, tag)} – ${formatDay(addDays(monday, 6), tag)}`
              : formatDay(date, tag)}
          </strong>
          <span className="small muted">{location.name}</span>
        </div>
        <div className="tabs cal-mode" role="group" aria-label={t.calendar.viewLabel}>
          <button type="button" aria-pressed={mode === 'day'} onClick={() => setMode('day')}>
            {t.calendar.dayView}
          </button>
          <button type="button" aria-pressed={mode === 'week'} onClick={() => setMode('week')}>
            {t.calendar.weekView}
          </button>
        </div>
        {mode === 'week' && data && data.staff.length > 1 ? (
          <select
            className="cal-staff-pick"
            aria-label={t.calendar.weekOf}
            value={weekStaff?.id ?? ''}
            onChange={(e) => setWeekStaffId(e.target.value)}
          >
            {data.staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="icon-btn hide-mobile"
          aria-label={mode === 'week' ? t.calendar.previousWeek : t.calendar.previousDay}
          onClick={() => setDate(addDays(date, mode === 'week' ? -7 : -1))}
        >
          ‹
        </button>
        <button type="button" className="btn btn--quiet btn--small" onClick={() => setDate(today)}>
          {t.common.today}
        </button>
        <button
          type="button"
          className="icon-btn hide-mobile"
          aria-label={mode === 'week' ? t.calendar.nextWeek : t.calendar.nextDay}
          onClick={() => setDate(addDays(date, mode === 'week' ? 7 : 1))}
        >
          ›
        </button>
        <a
          className="btn btn--quiet btn--small hide-mobile"
          href={`/${locale}/app/calendar/print?date=${date}`}
          target="_blank"
          rel="noopener"
          title={t.dayPlan.open}
          aria-label={t.dayPlan.open}
        >
          🖨
        </a>
        <button
          type="button"
          className="btn btn--quiet btn--small hide-mobile"
          onClick={() =>
            setDraft({
              kind: 'block',
              staffId: (weekStaff ?? data?.staff[0])?.id ?? null,
              date,
              minute: 12 * 60,
            })
          }
        >
          {t.calendar.blockTime}
        </button>
        <button
          type="button"
          className="btn btn--small"
          aria-label={t.calendar.newAppointment}
          onClick={() =>
            setDraft({
              kind: 'appointment',
              staffId: (weekStaff ?? data?.staff[0])?.id ?? null,
              date,
              minute: 12 * 60,
            })
          }
        >
          +<span className="hide-mobile">&nbsp;{t.calendar.newAppointment}</span>
        </button>
      </div>

      <div className="week-strip" role="group" aria-label={formatDay(monday, tag)}>
        <button
          type="button"
          className="week-arrow"
          aria-label={t.calendar.previousWeek}
          onClick={() => setDate(addDays(date, -7))}
        >
          ‹
        </button>
        {week.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={mode === 'day' && d === date}
            className={d === today ? 'is-today' : undefined}
            onClick={() => {
              setDate(d);
              setMode('day');
            }}
          >
            <span>{weekdayShort(d, tag)}</span>
            <b>{Number(d.slice(8))}</b>
          </button>
        ))}
        <button
          type="button"
          className="week-arrow"
          aria-label={t.calendar.nextWeek}
          onClick={() => setDate(addDays(date, 7))}
        >
          ›
        </button>
      </div>

      {manager && mode === 'day' && date === today ? (
        <TillReminder base={base} today={today} refresh={data} onOpen={setDate} />
      ) : null}

      {canSeeTill && mode === 'day' && date <= today ? (
        <TillStrip base={base} date={date} currency={location.currency} refresh={data} />
      ) : null}

      {error ? (
        <div style={{ padding: '8px 24px' }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}

      {!data || !view ? (
        <Spinner />
      ) : data.staff.length === 0 ? (
        <div className="cal-empty muted">{t.calendar.noStaff}</div>
      ) : (
        <div className="cal-scroll" ref={scroller}>
          <div
            className={mode === 'week' ? 'cal-grid cal-grid--week' : 'cal-grid'}
            ref={grid}
            data-testid={mode === 'week' ? 'calendar-week' : 'calendar-day'}
            style={{ '--cols': view.columns.length } as CSSProperties}
          >
            <div className="cal-head">
              <div className="corner" />
              {view.columns.map(({ key, staff: s, date: day }) => {
                const hours = s.days.find((d) => d.date === day)?.intervals ?? [];
                return (
                  <div
                    key={key}
                    className={`staff-head${mode === 'week' && day === today ? ' is-today' : ''}`}
                  >
                    {mode === 'week' ? (
                      <button
                        type="button"
                        className="avatar day-pick"
                        aria-label={formatDay(day, tag)}
                        onClick={() => {
                          setMode('day');
                          setDate(day);
                        }}
                      >
                        {Number(day.slice(8))}
                      </button>
                    ) : (
                      <span className="avatar" aria-hidden="true">
                        {initials(s.displayName)}
                      </span>
                    )}
                    <span>
                      {mode === 'week' ? weekdayShort(day, tag) : s.displayName}
                      <small>
                        {hours.length
                          ? hours.map((h) => `${h.start}–${h.end}`).join(', ')
                          : t.calendar.dayOff}
                      </small>
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="rail" aria-hidden="true">
              {Array.from({ length: (view.endMin - view.startMin) / 60 }, (_, i) => (
                <div key={i}>{i === 0 ? '' : minutesToClock(view.startMin + i * 60)}</div>
              ))}
            </div>

            {view.columns.map(({ key, staff: s, date: day }) => {
              const hours = s.days.find((d) => d.date === day)?.intervals ?? [];
              const height = ((view.endMin - view.startMin) / 60) * HOUR_PX;
              const nowLocal = toLocal(now, tz);
              return (
                <div
                  key={key}
                  className="col"
                  style={{ height }}
                  data-staff-col={s.id}
                  data-col-date={day}
                >
                  {hours.map((h) => (
                    <div
                      key={h.start}
                      className="work"
                      style={{
                        top: px(clockToMinutes(h.start)),
                        height: px(clockToMinutes(h.end)) - px(clockToMinutes(h.start)),
                        backgroundPositionY: -px(clockToMinutes(h.start)),
                      }}
                    />
                  ))}
                  <button
                    type="button"
                    className="slot-btn"
                    style={{ top: 0, height }}
                    aria-label={`${t.calendar.newAppointment}: ${
                      mode === 'week' ? formatDay(day, tag) : s.displayName
                    }`}
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const step = data.location.slotStepMinutes || 15;
                      const raw = view.startMin + ((e.clientY - rect.top) / HOUR_PX) * 60;
                      openNew(s.id, day, Math.max(0, Math.floor(raw / step) * step));
                    }}
                  />
                  {data.timeOff
                    .filter((o) => o.staffId === s.id)
                    .map((o) => {
                      const top = px(Math.max(view.startMin, dayMinute(o.start, day)));
                      const bottom = px(Math.min(view.endMin, dayMinute(o.end, day)));
                      if (bottom <= top) return null;
                      return (
                        <div key={o.id} className="block" style={{ top, height: bottom - top }}>
                          {o.note ?? t.calendar.dayOff}
                        </div>
                      );
                    })}
                  {view.blocks
                    .filter((b) => b.staffId === s.id || b.staffId === null)
                    .map((b) => {
                      const top = px(Math.max(view.startMin, dayMinute(b.start, day)));
                      const bottom = px(Math.min(view.endMin, dayMinute(b.end, day)));
                      if (bottom <= top) return null;
                      return (
                        <button
                          key={b.id}
                          type="button"
                          className="block"
                          style={{ top, height: bottom - top }}
                          onClick={() => setOpenBlock(b)}
                        >
                          {b.reason ?? t.calendar.blocked}
                          {b.staffId === null ? ` · ${t.calendar.wholeSalon}` : ''}
                        </button>
                      );
                    })}
                  {view.appointments
                    .filter((a) => a.staff.id === s.id && a.date === day)
                    .map((a) => (
                      <AppointmentBlock
                        key={a.id}
                        appointment={a}
                        top={px(clockToMinutes(a.time))}
                        height={Math.max(26, (a.durationMinutes / 60) * HOUR_PX - 2)}
                        color={colors.get(a.service.id)}
                        dragging={drag?.moved === true && drag.appointment.id === a.id}
                        onOpen={() => {
                          if (!justDragged.current) setOpenAppointment(a.id);
                        }}
                        onPointerDown={(e) => startDrag(e, a)}
                        onPointerMove={moveDrag}
                        onPointerUp={() => endDrag(false)}
                        onPointerCancel={() => endDrag(true)}
                      />
                    ))}
                  {drag?.moved && drag.staffId === s.id && drag.date === day ? (
                    <div
                      className="event is-ghost"
                      aria-hidden="true"
                      style={{
                        top: px(drag.minute),
                        height: Math.max(26, (drag.appointment.durationMinutes / 60) * HOUR_PX - 2),
                      }}
                    >
                      <span className="t">
                        {minutesToClock(drag.minute)}–
                        {minutesToClock(drag.minute + drag.appointment.durationMinutes)}
                      </span>
                      <span className="n">{drag.appointment.customer?.name ?? '—'}</span>
                    </div>
                  ) : null}
                  {day === nowLocal.date &&
                  nowLocal.minute >= view.startMin &&
                  nowLocal.minute <= view.endMin ? (
                    <div className="now-line" style={{ top: px(nowLocal.minute) }} />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ padding: '10px 24px' }}>
        <label className="check small">
          <input
            type="checkbox"
            checked={showCancelled}
            onChange={(e) => setShowCancelled(e.target.checked)}
          />
          <span>{t.calendar.showCancelled}</span>
        </label>
        {canDrag ? <p className="small muted hide-mobile">{t.calendar.dragHint}</p> : null}
      </div>

      {openAppointment ? (
        <AppointmentSheet
          id={openAppointment}
          base={base}
          staffList={staffList}
          onClose={() => setOpenAppointment(null)}
          onChanged={() => void load(true)}
          onBookAgain={(visit) => {
            // Task 223: the same client, service, specialist and time; the date is picked in the
            // form (today at the earliest).
            setOpenAppointment(null);
            setDraft({
              kind: 'appointment',
              staffId: visit.staff.id,
              date: visit.date > today ? visit.date : today,
              minute: clockToMinutes(visit.time),
              serviceId: visit.service.id,
              customer: visit.customer
                ? { id: visit.customer.id, name: visit.customer.name, phone: visit.customer.phone }
                : undefined,
            });
          }}
        />
      ) : null}
      {openBlock ? (
        <BlockSheet
          block={openBlock}
          base={base}
          staffList={staffList}
          onClose={() => setOpenBlock(null)}
          onChanged={() => void load(true)}
        />
      ) : null}
      {moveTarget ? (
        <MoveSheet
          target={moveTarget}
          base={base}
          tz={tz}
          staffList={staffList}
          canOutside={canOutside}
          onClose={() => setMoveTarget(null)}
          onMoved={() => {
            setMoveTarget(null);
            void load(true);
          }}
        />
      ) : null}
      {draft ? (
        <NewItemSheet
          draft={draft}
          base={base}
          services={services}
          staffList={staffList}
          onClose={() => setDraft(null)}
          onCreated={(createdDate) => {
            setDraft(null);
            if (createdDate !== date) setDate(createdDate);
            else void load(true);
          }}
        />
      ) : null}
    </>
  );
}

function AppointmentBlock({
  appointment: a,
  top,
  height,
  color,
  dragging,
  onOpen,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  appointment: Appointment;
  top: number;
  height: number;
  color: string | undefined;
  dragging: boolean;
  onOpen: () => void;
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}) {
  const { t } = useI18n();
  const end = minutesToClock(clockToMinutes(a.time) + a.durationMinutes);
  const classes = ['event'];
  if (a.status === 'held' || a.awaitingApproval) classes.push('is-held');
  if (a.status === 'completed') classes.push('is-done');
  if (a.status === 'no_show') classes.push('is-noshow');
  if (a.status === 'cancelled') classes.push('is-cancelled');
  if (dragging) classes.push('is-dragging');
  return (
    <button
      type="button"
      className={classes.join(' ')}
      style={{ top, height, '--svc': color } as CSSProperties}
      onClick={onOpen}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <span className="t">
        {a.time}–{end}
      </span>
      <span className="n">
        {a.status === 'held'
          ? t.calendar.held
          : `${a.awaitingApproval ? '⏳ ' : ''}${a.customer?.name ?? '—'}`}
      </span>
      <span className="s">{a.service.name}</span>
    </button>
  );
}
