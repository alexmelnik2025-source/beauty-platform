import { FormField } from '../formFields';
import { useFormDraft } from '../formDrafts';
import { useCallback, useEffect, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Locale, TimeOffList, WorkingHours } from '../api';
import { addDays, dayTitle, daysOff, timeOffText, weekRows } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { hoursOff, specialBody, specialInput, weeklyBody, weekInputs } from '../hours';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';
import { StaffProfileSection } from './StaffProfileSection';

/**
 * A specialist's schedule: weekly hours, special days and time off — the signed-in person's own,
 * or (task 95) anyone's from "Grafik zespołu". The owner or a manager changes the weekly hours
 * and time off here; a specialist only reads them (the server checks). Task 335: they also set
 * special hours for one date ("Dzień specjalny") and remove them. Task 326: from "Grafik
 * zespołu" the page starts with the specialist's profile (StaffProfileSection).
 */
export function ScheduleScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  staffId: string;
  /** Task 95: someone else's schedule, opened from "Grafik zespołu" (owner or manager). */
  staffName?: string;
  /** Task 326: the specialist's name was changed in their profile. */
  onRenamed?: (name: string) => void;
  /** Task 372: the specialist's profile or photo was saved. */
  onSaved?: () => void;
  /** Task 328: shown at the top when the page opens (a specialist was just added). */
  notice?: string;
  today: string;
  onBack: () => void;
}) {
  const { api, t, salon, staffId, onBack } = props;
  const s = t.schedule;
  const canEdit = salon.role !== 'staff';
  const [hours, setHours] = useState<WorkingHours | null>(null);
  const [offs, setOffs] = useState<TimeOffList>([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState(props.notice ?? '');
  const [busy, setBusy] = useState(false);
  /** Time off being added; task 338: `part` = the hours of one day ("12:00–15:00"), null = whole days. */
  const [form, setForm, resetForm] = useFormDraft<{
    from: string;
    to: string;
    note: string;
    part: string | null;
  } | null>(`schedule.${staffId}.form`, null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [weekEdits, setWeekEdits, resetWeek] = useFormDraft<Record<number, string> | null>(
    `schedule.${staffId}.week`,
    null,
  );
  const week = weekEdits && hours ? { ...weekInputs(hours), ...weekEdits } : null;
  const [badDay, setBadDay] = useState<number | null>(null);
  /** Task 335: "Dzień specjalny" — the date and the hours being typed, and what to fix. */
  const [special, setSpecial, resetSpecial] = useFormDraft<{
    date: string;
    text?: string;
    carryFromDate?: string;
  } | null>(`schedule.${staffId}.special`, null);
  const savedHours = special && hours ? specialInput(hours, special.date) : '';
  const carriedHours =
    special?.carryFromDate && hours ? specialInput(hours, special.carryFromDate) : '';
  const specialText = special?.text ?? (savedHours || carriedHours);
  const [specialProblem, setSpecialProblem] = useState<'empty' | 'bad' | null>(null);
  const [removingSpecial, setRemovingSpecial] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [h, o] = await Promise.all([
        api.workingHours(salon.orgId, salon.locationId, staffId),
        api.timeOff(salon.orgId, salon.locationId, staffId),
      ]);
      setHours(h);
      setOffs(o);
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, staffId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Android "back" closes the schedule instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  async function run(action: () => Promise<unknown>, done: string, onSuccess?: () => void) {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await action();
      onSuccess?.();
      setInfo(done);
      await load();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!form) return;
    const range = form.part !== null ? hoursOff(form.from, form.part) : daysOff(form.from, form.to);
    if (!range) {
      setError(form.part !== null ? s.badOffHours : s.badRange);
      return;
    }
    const note = form.note.trim();
    await run(
      () =>
        api.addTimeOff(salon.orgId, salon.locationId, staffId, {
          ...range,
          ...(note ? { note } : {}),
        }),
      s.added,
      resetForm,
    );
  }

  async function saveWeek() {
    if (!week) return;
    const body = weeklyBody(week);
    if (!body.ok) return setBadDay(body.weekday);
    setBadDay(null);
    await run(
      () => api.setWorkingHours(salon.orgId, salon.locationId, staffId, body.days).then(setHours),
      s.weekSaved,
      resetWeek,
    );
  }

  async function saveSpecial() {
    if (!special) return;
    const body = specialBody(specialText);
    if (!body.ok) return setSpecialProblem(body.problem);
    setSpecialProblem(null);
    await run(
      () =>
        api
          .setSpecialDay(salon.orgId, salon.locationId, staffId, special.date, body.intervals)
          .then(setHours),
      s.specialSaved,
      resetSpecial,
    );
  }

  /** ‹ › move the special day; never before today. The field shows that day's hours, if any. */
  const shiftSpecial = (days: number) => {
    if (!special || !hours) return;
    let date = addDays(special.date, days);
    if (date < props.today) date = props.today;
    if (date === special.date) return;
    if (specialInput(hours, date)) {
      setSpecial({ date });
    } else if (special.text === undefined && savedHours) {
      // Carry the previous hours by date so a return to the editor reads their latest value.
      setSpecial({ date, carryFromDate: special.date });
    } else {
      setSpecial({ ...special, date });
    }
  };

  const shift = (key: 'from' | 'to', days: number) => {
    if (!form) return;
    const next = { ...form, [key]: addDays(form[key], days) };
    // "From" never goes before today; "to" follows "from" forward.
    if (next.from < props.today) next.from = props.today;
    if (next.to < next.from) next.to = next.from;
    setForm(next);
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.row}>
        <Button kind="link" label={s.back} onPress={onBack} />
      </View>
      <Heading>{props.staffName ? fill(s.staffTitle, { name: props.staffName }) : s.title}</Heading>
      <Text style={styles.muted}>{salon.locationName}</Text>
      {props.staffName && canEdit ? (
        <StaffProfileSection
          api={api}
          t={t}
          salon={salon}
          staffId={staffId}
          onRenamed={(name) => props.onRenamed?.(name)}
          onSaved={props.onSaved}
        />
      ) : null}
      {error && error !== s.badOffHours && error !== s.badRange ? (
        <ErrorText>{error}</ErrorText>
      ) : null}
      {info ? <Text style={styles.info}>{info}</Text> : null}

      {hours ? (
        <>
          <Text style={styles.section}>{s.week}</Text>
          {week ? (
            <Card>
              <Text style={styles.small}>{s.weekHint}</Text>
              {weekRows(hours, props.locale).map((d) => (
                <View key={d.weekday} style={styles.dateRow}>
                  <Text style={styles.dayName}>{d.name}</Text>
                  <FormField
                    error={badDay === d.weekday ? fill(s.badHours, { day: d.name }) : undefined}
                    accessibilityLabel={d.name}
                    placeholder={s.dayOff}
                    value={week[d.weekday] ?? ''}
                    maxLength={80}
                    onChangeText={(text) => setWeekEdits({ ...weekEdits, [d.weekday]: text })}
                    style={styles.input}
                  />
                </View>
              ))}
              <View style={styles.row}>
                <Button label={s.saveWeek} busy={busy} onPress={() => void saveWeek()} />
                <Button
                  kind="link"
                  label={s.cancel}
                  onPress={() => {
                    resetWeek();
                    setBadDay(null);
                  }}
                />
              </View>
            </Card>
          ) : (
            <Card>
              {weekRows(hours, props.locale).map((d) => (
                <View key={d.weekday} style={styles.dayRow}>
                  <Text style={styles.dayName}>{d.name}</Text>
                  <Text style={d.hours ? styles.value : styles.muted}>{d.hours ?? s.dayOff}</Text>
                </View>
              ))}
            </Card>
          )}
          {!canEdit ? (
            <Text style={styles.small}>{s.readOnly}</Text>
          ) : !week ? (
            <Button
              kind="secondary"
              label={s.editWeek}
              onPress={() => {
                setInfo('');
                setWeekEdits({});
              }}
            />
          ) : null}

          {hours.overrides.length > 0 || canEdit ? (
            <Text style={styles.section}>{s.special}</Text>
          ) : null}
          {hours.overrides.length > 0 ? (
            <Card>
              {hours.overrides.map((o) => (
                <View key={o.date} style={styles.specialRow}>
                  <View style={styles.dayRow}>
                    <Text style={styles.dayName}>{dayTitle(o.date, props.locale)}</Text>
                    <Text style={o.intervals.length ? styles.value : styles.muted}>
                      {o.intervals.length
                        ? o.intervals.map((i) => `${i.start}–${i.end}`).join(', ')
                        : s.dayOff}
                    </Text>
                  </View>
                  {/* Task 335: the date gets the usual weekly hours back. */}
                  {canEdit && removingSpecial === o.date ? (
                    <View style={styles.row}>
                      <Text style={styles.muted}>{s.specialRemoveAsk}</Text>
                      <Button
                        kind="secondary"
                        label={s.no}
                        onPress={() => setRemovingSpecial(null)}
                      />
                      <Button
                        label={s.yes}
                        busy={busy}
                        onPress={() =>
                          void run(
                            () =>
                              api.removeSpecialDay(salon.orgId, salon.locationId, staffId, o.date),
                            s.specialRemoved,
                          ).then(() => setRemovingSpecial(null))
                        }
                      />
                    </View>
                  ) : canEdit ? (
                    <View style={styles.row}>
                      <Button
                        kind="link"
                        label={s.specialRemove}
                        a11yLabel={`${s.specialRemove}: ${dayTitle(o.date, props.locale)}`}
                        onPress={() => {
                          setInfo('');
                          setRemovingSpecial(o.date);
                        }}
                      />
                    </View>
                  ) : null}
                </View>
              ))}
            </Card>
          ) : null}
          {canEdit && !special ? (
            <Button
              kind="secondary"
              label={s.specialAdd}
              onPress={() => {
                setInfo('');
                setSpecialProblem(null);
                setSpecial({ date: props.today });
              }}
            />
          ) : null}
          {canEdit && special ? (
            <Card>
              <View style={styles.dateRow}>
                <Text style={styles.label}>{s.specialDay}</Text>
                <View style={styles.row}>
                  <Button
                    kind="secondary"
                    label="‹"
                    a11yLabel={`${s.specialDay}: ${s.earlier}`}
                    disabled={special.date <= props.today}
                    onPress={() => shiftSpecial(-1)}
                  />
                  <Text style={styles.value}>{dayTitle(special.date, props.locale)}</Text>
                  <Button
                    kind="secondary"
                    label="›"
                    a11yLabel={`${s.specialDay}: ${s.later}`}
                    onPress={() => shiftSpecial(1)}
                  />
                </View>
              </View>
              <View style={styles.dateRow}>
                <Text style={styles.label}>{s.specialHours}</Text>
                <FormField
                  error={
                    specialProblem
                      ? specialProblem === 'empty'
                        ? s.specialEmpty
                        : s.specialBad
                      : undefined
                  }
                  accessibilityLabel={s.specialHours}
                  placeholder="10:00–14:00"
                  value={specialText}
                  maxLength={80}
                  onChangeText={(text) => setSpecial({ date: special.date, text })}
                  style={styles.input}
                />
                <Text style={styles.small}>{s.specialHint}</Text>
              </View>
              <View style={styles.row}>
                <Button label={s.specialSave} busy={busy} onPress={() => void saveSpecial()} />
                <Button
                  kind="link"
                  label={s.cancel}
                  onPress={() => {
                    resetSpecial();
                    setSpecialProblem(null);
                  }}
                />
              </View>
            </Card>
          ) : null}

          <Text style={styles.section}>{s.timeOff}</Text>
          {offs.length === 0 ? <Text style={styles.muted}>{s.noTimeOff}</Text> : null}
          {offs.map((o) => (
            <Card key={o.id}>
              <Text style={styles.value}>{timeOffText(o, props.locale)}</Text>
              {o.note ? <Text style={styles.muted}>{o.note}</Text> : null}
              {canEdit && removing === o.id ? (
                <View style={styles.row}>
                  <Text style={styles.muted}>{s.removeAsk}</Text>
                  <Button kind="secondary" label={s.no} onPress={() => setRemoving(null)} />
                  <Button
                    label={s.yes}
                    busy={busy}
                    onPress={() =>
                      void run(
                        () => api.removeTimeOff(salon.orgId, salon.locationId, staffId, o.id),
                        '',
                      ).then(() => setRemoving(null))
                    }
                  />
                </View>
              ) : canEdit ? (
                <View style={styles.row}>
                  <Button kind="link" label={s.remove} onPress={() => setRemoving(o.id)} />
                </View>
              ) : null}
            </Card>
          ))}

          {canEdit && !form ? (
            <Button
              kind="secondary"
              label={s.add}
              onPress={() => {
                setInfo('');
                setForm({ from: props.today, to: props.today, note: '', part: null });
              }}
            />
          ) : null}
          {canEdit && form ? (
            <Card>
              {/* Task 338: whole days, or a few hours of one day. */}
              <View style={[styles.row, { marginBottom: 8 }]}>
                <Button
                  kind={form.part === null ? 'primary' : 'secondary'}
                  label={s.wholeDays}
                  onPress={() => setForm({ ...form, part: null })}
                />
                <Button
                  kind={form.part !== null ? 'primary' : 'secondary'}
                  label={s.partDay}
                  onPress={() => setForm({ ...form, to: form.from, part: form.part ?? '' })}
                />
              </View>
              {(form.part !== null ? (['from'] as const) : (['from', 'to'] as const)).map((key) => {
                // Task 338: one day ("Dzień") for a part of a day, "Od"/"Do" for whole days.
                const label = form.part !== null ? s.specialDay : key === 'from' ? s.from : s.to;
                return (
                  <View key={key} style={styles.dateRow}>
                    <Text style={styles.label}>{label}</Text>
                    <View style={styles.row}>
                      <Button
                        kind="secondary"
                        label="‹"
                        a11yLabel={`${label}: ${s.earlier}`}
                        onPress={() => shift(key, -1)}
                      />
                      <Text style={styles.value}>{dayTitle(form[key], props.locale)}</Text>
                      <Button
                        kind="secondary"
                        label="›"
                        a11yLabel={`${label}: ${s.later}`}
                        onPress={() => shift(key, 1)}
                      />
                    </View>
                  </View>
                );
              })}
              {error === s.badRange ? <ErrorText>! {error}</ErrorText> : null}
              {form.part !== null ? (
                <View style={styles.dateRow}>
                  <Text style={styles.label}>{s.offHours}</Text>
                  <FormField
                    error={error === s.badOffHours ? error : undefined}
                    accessibilityLabel={s.offHours}
                    placeholder="12:00–15:00"
                    value={form.part}
                    maxLength={20}
                    onChangeText={(part) => setForm({ ...form, part })}
                    style={styles.input}
                  />
                </View>
              ) : null}
              <TextInput
                accessibilityLabel={s.note}
                placeholder={s.note}
                value={form.note}
                maxLength={200}
                onChangeText={(note) => setForm({ ...form, note })}
                style={styles.input}
              />
              <View style={styles.row}>
                <Button label={s.save} busy={busy} onPress={() => void save()} />
                <Button
                  kind="link"
                  label={s.cancel}
                  onPress={() => {
                    resetForm();
                    setError('');
                  }}
                />
              </View>
            </Card>
          ) : null}
        </>
      ) : !error ? (
        <Text style={styles.muted}>{t.loading}</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  section: { marginTop: 8, fontSize: 13, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  dayRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 4,
  },
  dayName: { fontSize: 15, color: colors.ink, textTransform: 'capitalize' },
  dateRow: { gap: 4, marginBottom: 8 },
  specialRow: { paddingVertical: 2 },
  label: { fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  value: { fontSize: 15, color: colors.ink, flexShrink: 1 },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  info: { color: colors.ink, fontSize: 15 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    backgroundColor: colors.card,
    color: colors.ink,
  },
});
