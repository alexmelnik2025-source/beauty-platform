'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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
import { NewItemSheet, type NewItemDraft } from './NewItemSheet';

const REFRESH_MS = 30_000;
const HOUR_PX = 80;

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
  const [openAppointment, setOpenAppointment] = useState<string | null>(null);
  const [openBlock, setOpenBlock] = useState<TimeBlock | null>(null);
  const [draft, setDraft] = useState<NewItemDraft | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const etag = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);

  const load = useCallback(
    async (fresh = false) => {
      if (fresh) etag.current = null;
      try {
        const res = await apiResponse(`${base}/calendar`, {
          query: { from: date, to: date },
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
    [base, date, t],
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

  const today = todayIn(tz);
  const monday = weekStart(date);
  const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i));

  const view = useMemo(() => {
    if (!data) return null;
    const appointments = data.appointments.filter(
      (a) => a.date === date && (showCancelled || a.status !== 'cancelled'),
    );
    const blocks = data.blocks.filter((b) => !b.deleted);
    // Visible hours: everyone's working time plus anything booked outside it.
    let first = Infinity;
    let last = -Infinity;
    for (const s of data.staff) {
      for (const i of s.days.find((d) => d.date === date)?.intervals ?? []) {
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
    return { appointments, blocks, startMin, endMin };
  }, [data, date, showCancelled]);

  const px = (minutes: number) => ((minutes - (view?.startMin ?? 0)) / 60) * HOUR_PX;

  // Once per day shown: scroll to the current time (today) or to the first visit.
  useEffect(() => {
    if (!view || !scroller.current || scrolledFor.current === `${location.id}:${date}`) return;
    scrolledFor.current = `${location.id}:${date}`;
    const nowLocal = toLocal(Date.now(), tz);
    const first = view.appointments.map((a) => clockToMinutes(a.time)).sort((x, y) => x - y)[0];
    const target = date === nowLocal.date ? nowLocal.minute : (first ?? view.startMin + 60);
    scroller.current.scrollTop = Math.max(0, ((target - view.startMin) / 60) * HOUR_PX - HOUR_PX);
  }, [view, date, location.id, tz]);

  /** Minutes of an ISO instant within the shown day (clipped to the day). */
  const dayMinute = (iso: string) => {
    const local = toLocal(iso, tz);
    if (local.date < date) return 0;
    if (local.date > date) return 24 * 60;
    return local.minute;
  };

  function openNew(staffId: string, minute: number) {
    setDraft({ kind: 'appointment', staffId, date, minute });
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
          <strong>{formatDay(date, tag)}</strong>
          <span className="small muted">{location.name}</span>
        </div>
        <button
          type="button"
          className="icon-btn hide-mobile"
          aria-label={t.calendar.previousDay}
          onClick={() => setDate(addDays(date, -1))}
        >
          ‹
        </button>
        <button type="button" className="btn btn--quiet btn--small" onClick={() => setDate(today)}>
          {t.common.today}
        </button>
        <button
          type="button"
          className="icon-btn hide-mobile"
          aria-label={t.calendar.nextDay}
          onClick={() => setDate(addDays(date, 1))}
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
            setDraft({ kind: 'block', staffId: data?.staff[0]?.id ?? null, date, minute: 12 * 60 })
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
              staffId: data?.staff[0]?.id ?? null,
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
            aria-pressed={d === date}
            className={d === today ? 'is-today' : undefined}
            onClick={() => setDate(d)}
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
          <div className="cal-grid" style={{ '--cols': data.staff.length } as CSSProperties}>
            <div className="cal-head">
              <div className="corner" />
              {data.staff.map((s) => {
                const hours = s.days.find((d) => d.date === date)?.intervals ?? [];
                return (
                  <div key={s.id} className="staff-head">
                    <span className="avatar" aria-hidden="true">
                      {initials(s.displayName)}
                    </span>
                    <span>
                      {s.displayName}
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

            {data.staff.map((s) => {
              const hours = s.days.find((d) => d.date === date)?.intervals ?? [];
              const height = ((view.endMin - view.startMin) / 60) * HOUR_PX;
              const nowLocal = toLocal(now, tz);
              return (
                <div key={s.id} className="col" style={{ height }}>
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
                    aria-label={`${t.calendar.newAppointment}: ${s.displayName}`}
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const step = data.location.slotStepMinutes || 15;
                      const raw = view.startMin + ((e.clientY - rect.top) / HOUR_PX) * 60;
                      openNew(s.id, Math.max(0, Math.floor(raw / step) * step));
                    }}
                  />
                  {data.timeOff
                    .filter((o) => o.staffId === s.id)
                    .map((o) => {
                      const top = px(Math.max(view.startMin, dayMinute(o.start)));
                      const bottom = px(Math.min(view.endMin, dayMinute(o.end)));
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
                      const top = px(Math.max(view.startMin, dayMinute(b.start)));
                      const bottom = px(Math.min(view.endMin, dayMinute(b.end)));
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
                    .filter((a) => a.staff.id === s.id)
                    .map((a) => (
                      <AppointmentBlock
                        key={a.id}
                        appointment={a}
                        top={px(clockToMinutes(a.time))}
                        height={Math.max(26, (a.durationMinutes / 60) * HOUR_PX - 2)}
                        color={colors.get(a.service.id)}
                        onOpen={() => setOpenAppointment(a.id)}
                      />
                    ))}
                  {date === nowLocal.date &&
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
      </div>

      {openAppointment ? (
        <AppointmentSheet
          id={openAppointment}
          base={base}
          staffList={staffList}
          onClose={() => setOpenAppointment(null)}
          onChanged={() => void load(true)}
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
  onOpen,
}: {
  appointment: Appointment;
  top: number;
  height: number;
  color: string | undefined;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const end = minutesToClock(clockToMinutes(a.time) + a.durationMinutes);
  const classes = ['event'];
  if (a.status === 'held' || a.awaitingApproval) classes.push('is-held');
  if (a.status === 'completed') classes.push('is-done');
  if (a.status === 'no_show') classes.push('is-noshow');
  if (a.status === 'cancelled') classes.push('is-cancelled');
  return (
    <button
      type="button"
      className={classes.join(' ')}
      style={{ top, height, '--svc': color } as CSSProperties}
      onClick={onOpen}
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
