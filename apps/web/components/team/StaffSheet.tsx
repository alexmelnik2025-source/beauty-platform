'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { PHOTO_ACCEPT, shrinkPhoto, STAFF_PHOTO_SIDE } from '@/lib/photos';
import type { Staff, TimeOff as TimeOffEntry } from '@/lib/types';
import { LanguagePicker, type Spoken } from '../Languages';
import { ErrorBox, initials, Sheet, Spinner } from '../ui';

export type StaffRow = Staff;

interface Interval {
  start: string;
  end: string;
}

type TimeOff = TimeOffEntry;

/**
 * One specialist: profile, services, weekly hours and time off.
 * `memberEmail` is the email of the account linked to this profile, if any.
 */
export function StaffSheet({
  base,
  staff,
  services,
  memberEmail,
  onInvite,
  onClose,
  onSaved,
  onPhotoChange,
}: {
  base: string;
  staff: StaffRow | null;
  services: { id: string; name: string; active: boolean }[];
  memberEmail: string | null;
  onInvite: (staff: StaffRow) => void;
  onClose: () => void;
  onSaved: () => void;
  /** The photo is saved at once (not with the form); the list behind refreshes. */
  onPhotoChange: () => void;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [profile, setProfile] = useState({
    displayName: staff?.displayName ?? '',
    bio: staff?.bio ?? '',
    languages: staff?.languages ?? ([] as Spoken[]),
    active: staff?.active ?? true,
    serviceIds: staff?.serviceIds ?? services.filter((s) => s.active).map((s) => s.id),
  });
  const [week, setWeek] = useState<Interval[][] | null>(staff ? null : defaultWeek());
  const [timeOff, setTimeOff] = useState<TimeOff[]>([]);
  const [absence, setAbsence] = useState({ start: '', end: '', note: '' });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [photoUrl, setPhotoUrl] = useState(staff?.photoUrl ?? null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);

  const loadSchedule = useCallback(async () => {
    if (!staff) return;
    const [hours, off] = await Promise.all([
      api<{ weekly: { weekday: number; intervals: Interval[] }[] }>(
        `${base}/staff/${staff.id}/working-hours`,
      ),
      api<TimeOff[]>(`${base}/staff/${staff.id}/time-off`),
    ]);
    setWeek(
      Array.from(
        { length: 7 },
        (_, i) => hours.weekly.find((d) => d.weekday === i + 1)?.intervals ?? [],
      ),
    );
    setTimeOff(off);
  }, [base, staff]);

  useEffect(() => {
    void loadSchedule().catch((err) => setError(errorText(t, err)));
  }, [loadSchedule, t]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!week) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      let id = staff?.id;
      if (staff) {
        await api(`${base}/staff/${staff.id}`, {
          method: 'PATCH',
          body: {
            version: staff.version,
            displayName: profile.displayName,
            bio: profile.bio || null,
            languages: profile.languages,
            active: profile.active,
          },
        });
        await api(`${base}/staff/${staff.id}/services`, {
          method: 'PUT',
          body: { serviceIds: profile.serviceIds },
        });
      } else {
        const created = await api<{ id: string }>(`${base}/staff`, {
          method: 'POST',
          body: {
            displayName: profile.displayName,
            ...(profile.bio ? { bio: profile.bio } : {}),
            languages: profile.languages,
            serviceIds: profile.serviceIds,
          },
        });
        id = created.id;
      }
      await api(`${base}/staff/${id}/working-hours`, {
        method: 'PUT',
        body: {
          days: week
            .map((intervals, i) => ({ weekday: i + 1, intervals }))
            .filter((d) => d.intervals.length > 0),
        },
      });
      onSaved();
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  }

  async function addAbsence(e: FormEvent) {
    e.preventDefault();
    if (!staff) return;
    try {
      await api(`${base}/staff/${staff.id}/time-off`, {
        method: 'POST',
        body: {
          start: absence.start,
          end: absence.end,
          ...(absence.note ? { note: absence.note } : {}),
        },
      });
      setAbsence({ start: '', end: '', note: '' });
      await loadSchedule();
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  async function removeAbsence(id: string) {
    if (!staff) return;
    try {
      await api(`${base}/staff/${staff.id}/time-off/${id}`, { method: 'DELETE' });
      await loadSchedule();
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  async function setPhoto(file: File | undefined) {
    if (!staff || !file) return;
    setPhotoBusy(true);
    setError('');
    try {
      const blob = await shrinkPhoto(file, STAFF_PHOTO_SIDE);
      const saved = await api<{ url: string }>(`${base}/staff/${staff.id}/photo`, {
        method: 'PUT',
        file: blob,
      });
      setPhotoUrl(saved.url);
      onPhotoChange();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setPhotoBusy(false);
      if (photoInput.current) photoInput.current.value = '';
    }
  }

  async function removePhoto() {
    if (!staff) return;
    setError('');
    try {
      await api(`${base}/staff/${staff.id}/photo`, { method: 'DELETE' });
      setPhotoUrl(null);
      onPhotoChange();
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  const setDay = (day: number, intervals: Interval[]) =>
    setWeek((w) => w && w.map((d, i) => (i === day ? intervals : d)));

  const when = (local: string) =>
    new Intl.DateTimeFormat(tag, {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(`${local}:00Z`));

  return (
    <Sheet title={staff ? staff.displayName : t.team.addStaff} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <ErrorBox>{error}</ErrorBox>
        {message ? <p className="note">{message}</p> : null}
        {staff ? (
          <div className="staff-photo">
            <span className="avatar avatar--large">
              {photoUrl ? (
                <img src={photoUrl} alt={t.photos.staffAlt.replace('{name}', staff.displayName)} />
              ) : (
                <span aria-hidden="true">{initials(staff.displayName)}</span>
              )}
            </span>
            <label className={`btn btn--quiet btn--small${photoBusy ? ' is-disabled' : ''}`}>
              {photoBusy ? t.photos.uploading : photoUrl ? t.photos.change : t.photos.staffAdd}
              <input
                ref={photoInput}
                type="file"
                accept={PHOTO_ACCEPT}
                className="visually-hidden"
                disabled={photoBusy}
                aria-label={t.photos.staffAdd}
                onChange={(e) => void setPhoto(e.target.files?.[0])}
              />
            </label>
            {photoUrl ? (
              <button type="button" className="link-btn small" onClick={() => void removePhoto()}>
                {t.photos.staffRemove}
              </button>
            ) : null}
          </div>
        ) : null}
        <label className="field">
          <span>{t.team.displayName}</span>
          <input
            required
            maxLength={80}
            value={profile.displayName}
            onChange={(e) => setProfile({ ...profile, displayName: e.target.value })}
          />
        </label>
        <label className="field">
          <span>
            {t.team.bio} ({t.common.optional})
          </span>
          <textarea
            maxLength={500}
            value={profile.bio}
            onChange={(e) => setProfile({ ...profile, bio: e.target.value })}
          />
        </label>
        <LanguagePicker
          title={t.languages.staffTitle}
          hint={t.languages.staffHint}
          value={profile.languages}
          onChange={(languages) => setProfile({ ...profile, languages })}
        />
        {staff ? (
          <label className="check">
            <input
              type="checkbox"
              checked={profile.active}
              onChange={(e) => setProfile({ ...profile, active: e.target.checked })}
            />
            <span>{t.team.active}</span>
          </label>
        ) : null}

        <fieldset className="section" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>
            <h3>{t.team.services}</h3>
          </legend>
          {services.map((s) => (
            <label key={s.id} className="check">
              <input
                type="checkbox"
                checked={profile.serviceIds.includes(s.id)}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    serviceIds: e.target.checked
                      ? [...profile.serviceIds, s.id]
                      : profile.serviceIds.filter((id) => id !== s.id),
                  })
                }
              />
              <span>{s.name}</span>
            </label>
          ))}
        </fieldset>

        <section className="section">
          <h3>{t.team.hours}</h3>
          {week === null ? (
            <Spinner />
          ) : (
            <div>
              {t.weekdays.map((name, day) => (
                <div key={name} className="day-row">
                  <span>{name}</span>
                  <div className="intervals">
                    {week[day]!.length === 0 ? (
                      <span className="muted small">{t.team.dayOff}</span>
                    ) : null}
                    {week[day]!.map((interval, i) => (
                      <div key={i} className="interval">
                        <input
                          type="time"
                          step={300}
                          required
                          aria-label={`${name} ${t.team.start}`}
                          value={interval.start}
                          onChange={(e) =>
                            setDay(
                              day,
                              week[day]!.map((x, j) =>
                                j === i ? { ...x, start: e.target.value } : x,
                              ),
                            )
                          }
                        />
                        –
                        <input
                          type="time"
                          step={300}
                          required
                          aria-label={`${name} ${t.team.end}`}
                          value={interval.end}
                          onChange={(e) =>
                            setDay(
                              day,
                              week[day]!.map((x, j) =>
                                j === i ? { ...x, end: e.target.value } : x,
                              ),
                            )
                          }
                        />
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={t.team.removeInterval}
                          onClick={() =>
                            setDay(
                              day,
                              week[day]!.filter((_, j) => j !== i),
                            )
                          }
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="link-btn small"
                      style={{ justifySelf: 'start' }}
                      onClick={() =>
                        setDay(day, [
                          ...week[day]!,
                          week[day]!.length
                            ? { start: '14:00', end: '18:00' }
                            : { start: '09:00', end: '17:00' },
                        ])
                      }
                    >
                      {t.team.addInterval}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <button className="btn btn--block" disabled={busy || week === null}>
          {t.common.save}
        </button>
      </form>

      {staff ? (
        <section className="section">
          <h3>{t.team.timeOff}</h3>
          {timeOff.length === 0 ? <p className="small muted">{t.team.noTimeOff}</p> : null}
          <ul className="history">
            {timeOff.map((o) => (
              <li key={o.id}>
                <span>
                  {when(o.start)} – {when(o.end)}
                  {o.note ? <span className="muted"> · {o.note}</span> : null}
                </span>
                <button
                  type="button"
                  className="link-btn small"
                  onClick={() => void removeAbsence(o.id)}
                >
                  {t.actions.delete}
                </button>
              </li>
            ))}
          </ul>
          <form className="form" onSubmit={addAbsence}>
            <div className="row">
              <label className="field">
                <span>{t.team.start}</span>
                <input
                  type="datetime-local"
                  step={300}
                  required
                  value={absence.start}
                  onChange={(e) => setAbsence({ ...absence, start: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t.team.end}</span>
                <input
                  type="datetime-local"
                  step={300}
                  required
                  value={absence.end}
                  onChange={(e) => setAbsence({ ...absence, end: e.target.value })}
                />
              </label>
            </div>
            <label className="field">
              <span>
                {t.team.note} ({t.common.optional})
              </span>
              <input
                maxLength={200}
                value={absence.note}
                onChange={(e) => setAbsence({ ...absence, note: e.target.value })}
              />
            </label>
            <button className="btn btn--quiet">{t.team.addTimeOff}</button>
          </form>
        </section>
      ) : null}

      {staff ? (
        <section className="section">
          <h3>{t.team.account}</h3>
          {staff.userId ? (
            <p className="small">
              {memberEmail ? t.team.linked.replace('{email}', memberEmail) : '✓'}
            </p>
          ) : (
            <>
              <p className="small muted">{t.team.notLinked}</p>
              <button type="button" className="btn btn--quiet" onClick={() => onInvite(staff)}>
                {t.team.invite}
              </button>
            </>
          )}
        </section>
      ) : null}
    </Sheet>
  );
}

function defaultWeek(): Interval[][] {
  return Array.from({ length: 7 }, (_, i) => (i < 5 ? [{ start: '09:00', end: '18:00' }] : []));
}
