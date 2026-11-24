'use client';

import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, newIdempotencyKey } from '@/lib/api';
import { useSubmitLock } from '@/lib/submit-lock';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { PHOTO_ACCEPT, shrinkPhoto, STAFF_PHOTO_SIDE } from '@/lib/photos';
import type { Invitation, Staff, TimeOff as TimeOffEntry } from '@/lib/types';
import { LanguagePicker, type Spoken } from '../Languages';
import { SpecialtyPicker, type Specialty } from '../Specialties';
import { ErrorBox, FieldError, initials, Sheet, Spinner } from '../ui';

export type StaffRow = Staff;

interface Interval {
  start: string;
  end: string;
}

type TimeOff = TimeOffEntry;

/** Task 336: a date with its own hours instead of the weekly ones (location-local). */
interface SpecialDay {
  date: string;
  intervals: Interval[];
}

/**
 * One specialist: profile, services, weekly hours, special days (task 336) and time off.
 * `memberEmail` is the email of the account linked to this profile, if any.
 */
export function StaffSheet({
  base,
  staff,
  services,
  memberEmail,
  pendingInvitation,
  onInvite,
  onClose,
  onSaved,
  onPhotoChange,
}: {
  base: string;
  staff: StaffRow | null;
  services: { id: string; name: string; active: boolean }[];
  memberEmail: string | null;
  /** An invitation for this profile that has not been accepted yet. */
  pendingInvitation: Invitation | null;
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
    specialties: staff?.specialties ?? ([] as Specialty[]),
    customSpecialty: staff?.customSpecialty ?? '',
    active: staff?.active ?? true,
    serviceIds: staff?.serviceIds ?? services.filter((s) => s.active).map((s) => s.id),
  });
  const [week, setWeek] = useState<Interval[][] | null>(staff ? null : defaultWeek());
  const [timeOff, setTimeOff] = useState<TimeOff[]>([]);
  const [absence, setAbsence] = useState({ start: '', end: '', note: '' });
  const [specials, setSpecials] = useState<SpecialDay[]>([]);
  const [special, setSpecial] = useState({ date: '', start: '10:00', end: '14:00' });
  const [specialNote, setSpecialNote] = useState('');
  const [error, setError] = useState('');
  /**
   * Task 814 (owner's rule: errors where the action is): a refused "Zapisz" is said under that
   * button at the bottom of the sheet, a refused photo change under the photo — not at the top.
   */
  const [saveError, setSaveError] = useState('');
  const [photoError, setPhotoError] = useState('');
  /**
   * Task 660 (owner's rule: errors at the field): a name of only spaces is pointed out under
   * "Imię"; a special day or an absence whose "Do" is not after "Od" — under its "Do"; and the
   * server's answer about a special day or an absence stays in that section instead of the top
   * of the long sheet. Editing the field takes the error away.
   */
  const [nameProblem, setNameProblem] = useState(false);
  /**
   * Task 660 / 691 (owner's rule: errors at the field): what is wrong with a special day or an
   * absence, said under that field — an empty field, a past date, "Do" not after "Od".
   */
  const [specialProblems, setSpecialProblems] = useState<DayProblems>({});
  const [absenceProblems, setAbsenceProblems] = useState<DayProblems>({});
  /**
   * Task 823 (owner's rule: errors where the action is): a refused "Zapisz dzień specjalny" /
   * "Dodaj nieobecność" is said under that button; a refused "Usuń" under the row it removes
   * (`key` — the date or the absence id), not in a box above the add form.
   */
  const [specialError, setSpecialError] = useState<RowError | null>(null);
  const [absenceError, setAbsenceError] = useState<RowError | null>(null);
  /** A changed "Od" takes its own error away, and the "Do not after Od" one under "Do". */
  const fixStart = (problems: DayProblems): DayProblems => ({
    ...problems,
    start: undefined,
    end: problems.end === t.team.specialBadTime ? undefined : problems.end,
  });
  /**
   * Task 698 (owner's rule: errors at the field): an empty hour or an interval whose end is not
   * after its start, by "<weekday>.<interval>" — said under that interval instead of the
   * browser's bubble or the server's line at the top of the sheet. Changing the day clears it.
   */
  const [hoursProblems, setHoursProblems] = useState<
    Record<string, { field: 'start' | 'end'; text: string }>
  >({});
  const [message, setMessage] = useState('');
  const { busy, lock, unlock } = useSubmitLock();
  // One key per form: a repeated or retried "add" never creates a second specialist (T4).
  const [key] = useState(newIdempotencyKey);
  const [photoUrl, setPhotoUrl] = useState(staff?.photoUrl ?? null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);

  const loadSchedule = useCallback(async () => {
    if (!staff) return;
    const [hours, off] = await Promise.all([
      api<{ weekly: { weekday: number; intervals: Interval[] }[]; overrides: SpecialDay[] }>(
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
    setSpecials(hours.overrides);
    setTimeOff(off);
  }, [base, staff]);

  useEffect(() => {
    void loadSchedule().catch((err) => setError(errorText(t, err)));
  }, [loadSchedule, t]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!week) return;
    if (!profile.displayName.trim()) {
      setNameProblem(true);
      return;
    }
    const found: typeof hoursProblems = {};
    week.forEach((intervals, day) =>
      intervals.forEach((interval, i) => {
        if (!interval.start)
          found[`${day}.${i}`] = { field: 'start', text: t.onboarding.fieldRequired };
        else if (!interval.end)
          found[`${day}.${i}`] = { field: 'end', text: t.onboarding.fieldRequired };
        else if (interval.end <= interval.start) {
          found[`${day}.${i}`] = { field: 'end', text: t.team.specialBadTime };
        }
      }),
    );
    setHoursProblems(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(`hours-${first.replace('.', '-')}-${found[first]!.field}`)?.focus();
      return;
    }
    if (!lock()) return;
    setError('');
    setSaveError('');
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
            specialties: profile.specialties,
            customSpecialty: profile.customSpecialty.trim() || null,
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
          idempotencyKey: key,
          body: {
            displayName: profile.displayName,
            ...(profile.bio ? { bio: profile.bio } : {}),
            languages: profile.languages,
            specialties: profile.specialties,
            ...(profile.customSpecialty.trim()
              ? { customSpecialty: profile.customSpecialty.trim() }
              : {}),
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
      setSaveError(errorText(t, err));
      unlock();
    }
  }

  async function addAbsence(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!staff) return;
    setAbsenceError(null);
    const found: DayProblems = {};
    if (!absence.start) found.start = t.onboarding.fieldRequired;
    if (!absence.end) found.end = t.onboarding.fieldRequired;
    else if (absence.start && absence.end <= absence.start) found.end = t.team.specialBadTime;
    if (showProblems(found, setAbsenceProblems, e)) return;
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
      setAbsenceError({ key: ADD, text: errorText(t, err) });
    }
  }

  /** Task 336: special hours for one date (`PUT …/working-hours/overrides/:date`). */
  async function addSpecial(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!staff) return;
    setSpecialError(null);
    setSpecialNote('');
    const found: DayProblems = {};
    if (!special.date) found.date = t.onboarding.fieldRequired;
    else if (special.date < today()) found.date = t.errors.IN_THE_PAST;
    if (!special.start) found.start = t.onboarding.fieldRequired;
    if (!special.end) found.end = t.onboarding.fieldRequired;
    else if (special.start && special.end <= special.start) found.end = t.team.specialBadTime;
    if (showProblems(found, setSpecialProblems, e)) return;
    try {
      await api(`${base}/staff/${staff.id}/working-hours/overrides/${special.date}`, {
        method: 'PUT',
        body: { intervals: [{ start: special.start, end: special.end }] },
      });
      setSpecial({ date: '', start: '10:00', end: '14:00' });
      setSpecialNote(t.team.specialSaved);
      await loadSchedule();
    } catch (err) {
      setSpecialError({ key: ADD, text: errorText(t, err) });
    }
  }

  /** Task 336: the date gets the usual weekly hours back. */
  async function removeSpecial(date: string) {
    if (!staff) return;
    setSpecialError(null);
    setSpecialNote('');
    try {
      await api(`${base}/staff/${staff.id}/working-hours/overrides/${date}`, {
        method: 'DELETE',
      });
      setSpecialNote(t.team.specialRemoved);
      await loadSchedule();
    } catch (err) {
      setSpecialError({ key: date, text: errorText(t, err) });
    }
  }

  async function removeAbsence(id: string) {
    if (!staff) return;
    setAbsenceError(null);
    try {
      await api(`${base}/staff/${staff.id}/time-off/${id}`, { method: 'DELETE' });
      await loadSchedule();
    } catch (err) {
      setAbsenceError({ key: id, text: errorText(t, err) });
    }
  }

  async function setPhoto(file: File | undefined) {
    if (!staff || !file) return;
    setPhotoBusy(true);
    setPhotoError('');
    try {
      const blob = await shrinkPhoto(file, STAFF_PHOTO_SIDE);
      const saved = await api<{ url: string }>(`${base}/staff/${staff.id}/photo`, {
        method: 'PUT',
        file: blob,
      });
      setPhotoUrl(saved.url);
      onPhotoChange();
    } catch (err) {
      setPhotoError(errorText(t, err));
    } finally {
      setPhotoBusy(false);
      if (photoInput.current) photoInput.current.value = '';
    }
  }

  async function removePhoto() {
    if (!staff) return;
    setPhotoError('');
    try {
      await api(`${base}/staff/${staff.id}/photo`, { method: 'DELETE' });
      setPhotoUrl(null);
      onPhotoChange();
    } catch (err) {
      setPhotoError(errorText(t, err));
    }
  }

  const setDay = (day: number, intervals: Interval[]) => {
    setWeek((w) => w && w.map((d, i) => (i === day ? intervals : d)));
    // Task 698: the day's intervals changed (or moved up) — their errors go away.
    if (Object.keys(hoursProblems).some((key) => key.startsWith(`${day}.`))) {
      setHoursProblems((all) =>
        Object.fromEntries(Object.entries(all).filter(([key]) => !key.startsWith(`${day}.`))),
      );
    }
  };
  /** Task 698: the id and aria props of one hour of an interval, tied to its error. */
  const hourProps = (day: number, i: number, field: 'start' | 'end') => {
    const bad = hoursProblems[`${day}.${i}`]?.field === field;
    return {
      id: `hours-${day}-${i}-${field}`,
      'aria-invalid': bad || undefined,
      'aria-describedby': bad ? `hours-${day}-${i}-error` : undefined,
    };
  };

  const when = (local: string) =>
    new Intl.DateTimeFormat(tag, {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(`${local}:00Z`));
  /** Task 336: "środa, 24 grudnia" for a YYYY-MM-DD date. */
  const dayName = (date: string) =>
    new Intl.DateTimeFormat(tag, {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date(`${date}T12:00:00Z`));

  return (
    <Sheet title={staff ? staff.displayName : t.team.addStaff} onClose={onClose}>
      <form
        noValidate
        className="form"
        onSubmit={save}
        // Task 814: editing anything in the form takes the refused-save line away.
        onChange={() => setSaveError('')}
      >
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
                aria-describedby={photoError ? 'staff-photo-error' : undefined}
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
        {staff ? <FieldError id="staff-photo-error" text={photoError} /> : null}
        <label className="field">
          <span>{t.team.displayName}</span>
          <input
            required
            maxLength={80}
            value={profile.displayName}
            aria-invalid={nameProblem || undefined}
            aria-describedby={nameProblem ? 'staff-name-error' : undefined}
            onChange={(e) => {
              setProfile({ ...profile, displayName: e.target.value });
              setNameProblem(false);
            }}
          />
          <FieldError
            id="staff-name-error"
            text={nameProblem ? t.onboarding.fieldRequired : undefined}
          />
        </label>
        <SpecialtyPicker
          value={profile.specialties}
          custom={profile.customSpecialty}
          onChange={(specialties) => setProfile({ ...profile, specialties })}
          onCustomChange={(customSpecialty) => setProfile({ ...profile, customSpecialty })}
        />
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
                      <Fragment key={i}>
                        <div className="interval">
                          <input
                            type="time"
                            step={300}
                            required
                            {...hourProps(day, i, 'start')}
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
                            {...hourProps(day, i, 'end')}
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
                        <FieldError
                          id={`hours-${day}-${i}-error`}
                          text={hoursProblems[`${day}.${i}`]?.text}
                        />
                      </Fragment>
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

        <button
          className="btn btn--block"
          disabled={busy || week === null}
          aria-describedby={saveError ? 'staff-save-error' : undefined}
        >
          {t.common.save}
        </button>
        <FieldError id="staff-save-error" text={saveError} />
      </form>

      {staff ? (
        <section className="section" aria-labelledby="special-days">
          <h3 id="special-days">{t.team.special}</h3>
          <p className="small muted">{t.team.specialHint}</p>
          {specials.length === 0 ? <p className="small muted">{t.team.specialNone}</p> : null}
          <ul className="history">
            {specials.map((d) => (
              <li
                key={d.date}
                className={specialError?.key === d.date ? 'history__row--error' : undefined}
              >
                <span>
                  {dayName(d.date)} ·{' '}
                  {d.intervals.length
                    ? d.intervals.map((i) => `${i.start}–${i.end}`).join(', ')
                    : t.team.dayOff}
                </span>
                <button
                  type="button"
                  className="link-btn small"
                  aria-label={`${t.actions.delete}: ${dayName(d.date)}`}
                  aria-describedby={
                    specialError?.key === d.date ? `special-remove-error-${d.date}` : undefined
                  }
                  onClick={() => void removeSpecial(d.date)}
                >
                  {t.actions.delete}
                </button>
                {specialError?.key === d.date ? (
                  <FieldError id={`special-remove-error-${d.date}`} text={specialError.text} />
                ) : null}
              </li>
            ))}
          </ul>
          {specialNote ? (
            <p className="note" role="status">
              {specialNote}
            </p>
          ) : null}
          <form noValidate className="form" onSubmit={(e) => void addSpecial(e)}>
            <div className="row">
              <label className="field">
                <span>{t.team.specialDate}</span>
                <input
                  type="date"
                  required
                  min={today()}
                  name="date"
                  value={special.date}
                  {...invalid(specialProblems, 'date', 'special')}
                  onChange={(e) => {
                    setSpecial({ ...special, date: e.target.value });
                    setSpecialError(null);
                    setSpecialProblems({ ...specialProblems, date: undefined });
                  }}
                />
                <FieldError id="special-date-error" text={specialProblems.date} />
              </label>
              <label className="field">
                <span>{t.team.start}</span>
                <input
                  type="time"
                  step={300}
                  required
                  name="start"
                  value={special.start}
                  {...invalid(specialProblems, 'start', 'special')}
                  onChange={(e) => {
                    setSpecial({ ...special, start: e.target.value });
                    setSpecialError(null);
                    setSpecialProblems(fixStart(specialProblems));
                  }}
                />
                <FieldError id="special-start-error" text={specialProblems.start} />
              </label>
              <label className="field">
                <span>{t.team.end}</span>
                <input
                  type="time"
                  step={300}
                  required
                  name="end"
                  value={special.end}
                  {...invalid(specialProblems, 'end', 'special')}
                  onChange={(e) => {
                    setSpecial({ ...special, end: e.target.value });
                    setSpecialError(null);
                    setSpecialProblems({ ...specialProblems, end: undefined });
                  }}
                />
                <FieldError id="special-end-error" text={specialProblems.end} />
              </label>
            </div>
            <button
              className="btn btn--quiet"
              aria-describedby={specialError?.key === ADD ? 'special-add-error' : undefined}
            >
              {t.team.specialSave}
            </button>
            <FieldError
              id="special-add-error"
              text={specialError?.key === ADD ? specialError.text : ''}
            />
          </form>
        </section>
      ) : null}

      {staff ? (
        <section className="section" aria-labelledby="staff-time-off">
          <h3 id="staff-time-off">{t.team.timeOff}</h3>
          {timeOff.length === 0 ? <p className="small muted">{t.team.noTimeOff}</p> : null}
          <ul className="history">
            {timeOff.map((o) => (
              <li
                key={o.id}
                className={absenceError?.key === o.id ? 'history__row--error' : undefined}
              >
                <span>
                  {when(o.start)} – {when(o.end)}
                  {o.note ? <span className="muted"> · {o.note}</span> : null}
                </span>
                <button
                  type="button"
                  className="link-btn small"
                  aria-describedby={
                    absenceError?.key === o.id ? `absence-remove-error-${o.id}` : undefined
                  }
                  onClick={() => void removeAbsence(o.id)}
                >
                  {t.actions.delete}
                </button>
                {absenceError?.key === o.id ? (
                  <FieldError id={`absence-remove-error-${o.id}`} text={absenceError.text} />
                ) : null}
              </li>
            ))}
          </ul>
          <form noValidate className="form" onSubmit={(e) => void addAbsence(e)}>
            <div className="row">
              <label className="field">
                <span>{t.team.start}</span>
                <input
                  type="datetime-local"
                  step={300}
                  required
                  name="start"
                  value={absence.start}
                  {...invalid(absenceProblems, 'start', 'absence')}
                  onChange={(e) => {
                    setAbsence({ ...absence, start: e.target.value });
                    setAbsenceProblems(fixStart(absenceProblems));
                    setAbsenceError(null);
                  }}
                />
                <FieldError id="absence-start-error" text={absenceProblems.start} />
              </label>
              <label className="field">
                <span>{t.team.end}</span>
                <input
                  type="datetime-local"
                  step={300}
                  required
                  name="end"
                  value={absence.end}
                  {...invalid(absenceProblems, 'end', 'absence')}
                  onChange={(e) => {
                    setAbsence({ ...absence, end: e.target.value });
                    setAbsenceProblems({ ...absenceProblems, end: undefined });
                    setAbsenceError(null);
                  }}
                />
                <FieldError id="absence-end-error" text={absenceProblems.end} />
              </label>
            </div>
            <label className="field">
              <span>
                {t.team.note} ({t.common.optional})
              </span>
              <input
                maxLength={200}
                value={absence.note}
                onChange={(e) => {
                  setAbsence({ ...absence, note: e.target.value });
                  setAbsenceError(null);
                }}
              />
            </label>
            <button
              className="btn btn--quiet"
              aria-describedby={absenceError?.key === ADD ? 'absence-add-error' : undefined}
            >
              {t.team.addTimeOff}
            </button>
            <FieldError
              id="absence-add-error"
              text={absenceError?.key === ADD ? absenceError.text : ''}
            />
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
          ) : pendingInvitation ? (
            <>
              <p className="small" role="status">
                {fill(t.team.invitePending, { email: pendingInvitation.email })}
                {pendingInvitation.phone ? ` · ${pendingInvitation.phone}` : ''}
              </p>
              <button type="button" className="btn btn--quiet" onClick={() => onInvite(staff)}>
                {t.team.inviteAgain}
              </button>
            </>
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

/** Today in this browser, YYYY-MM-DD — special days start from today (task 336). */
type DayField = 'date' | 'start' | 'end';
/** Task 823: a refused action — `ADD` for the add form, else the date / absence id removed. */
type RowError = { key: string; text: string };
const ADD = 'add';
type DayProblems = Partial<Record<DayField, string>>;
const DAY_ORDER: DayField[] = ['date', 'start', 'end'];

/** Task 691: the texts under the fields; the cursor to the first. True when something is wrong. */
function showProblems(
  found: DayProblems,
  set: (found: DayProblems) => void,
  e: FormEvent<HTMLFormElement>,
): boolean {
  set(found);
  const first = DAY_ORDER.find((field) => found[field]);
  if (!first) return false;
  e.currentTarget.querySelector<HTMLInputElement>(`input[name="${first}"]`)?.focus();
  return true;
}

function invalid(problems: DayProblems, field: DayField, form: 'special' | 'absence') {
  return {
    'aria-invalid': problems[field] ? true : undefined,
    'aria-describedby': problems[field] ? `${form}-${field}-error` : undefined,
  };
}

function today(): string {
  return new Intl.DateTimeFormat('en-CA').format(new Date());
}
