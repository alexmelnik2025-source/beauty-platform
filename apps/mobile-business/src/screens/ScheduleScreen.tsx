import { useCallback, useEffect, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Locale, TimeOffList, WorkingHours } from '../api';
import { addDays, dayTitle, daysOff, timeOffText, weekRows } from '../day';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * The signed-in specialist's own schedule: weekly hours, special days and time off.
 * A specialist only reads it (the owner or a manager changes it — the server checks);
 * an owner or manager who also works as a specialist can add and remove their time off here.
 */
export function ScheduleScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  staffId: string;
  today: string;
  onBack: () => void;
}) {
  const { api, t, salon, staffId, onBack } = props;
  const s = t.schedule;
  const canEdit = salon.role !== 'staff';
  const [hours, setHours] = useState<WorkingHours | null>(null);
  const [offs, setOffs] = useState<TimeOffList>([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ from: string; to: string; note: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

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

  async function run(action: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await action();
      setInfo(done);
      await load();
      return true;
    } catch (e) {
      setError(errorText(e, t));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!form) return;
    const range = daysOff(form.from, form.to);
    if (!range) {
      setError(s.badRange);
      return;
    }
    const note = form.note.trim();
    const ok = await run(
      () =>
        api.addTimeOff(salon.orgId, salon.locationId, staffId, {
          ...range,
          ...(note ? { note } : {}),
        }),
      s.added,
    );
    if (ok) setForm(null);
  }

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
      <Heading>{s.title}</Heading>
      <Text style={styles.muted}>{salon.locationName}</Text>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {info ? <Text style={styles.info}>{info}</Text> : null}

      {hours ? (
        <>
          <Text style={styles.section}>{s.week}</Text>
          <Card>
            {weekRows(hours, props.locale).map((d) => (
              <View key={d.weekday} style={styles.dayRow}>
                <Text style={styles.dayName}>{d.name}</Text>
                <Text style={d.hours ? styles.value : styles.muted}>{d.hours ?? s.dayOff}</Text>
              </View>
            ))}
          </Card>
          <Text style={styles.small}>{canEdit ? s.weekInCabinet : s.readOnly}</Text>

          {hours.overrides.length > 0 ? (
            <>
              <Text style={styles.section}>{s.special}</Text>
              <Card>
                {hours.overrides.map((o) => (
                  <View key={o.date} style={styles.dayRow}>
                    <Text style={styles.dayName}>{dayTitle(o.date, props.locale)}</Text>
                    <Text style={o.intervals.length ? styles.value : styles.muted}>
                      {o.intervals.length
                        ? o.intervals.map((i) => `${i.start}–${i.end}`).join(', ')
                        : s.dayOff}
                    </Text>
                  </View>
                ))}
              </Card>
            </>
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
                setForm({ from: props.today, to: props.today, note: '' });
              }}
            />
          ) : null}
          {canEdit && form ? (
            <Card>
              {(['from', 'to'] as const).map((key) => (
                <View key={key} style={styles.dateRow}>
                  <Text style={styles.label}>{key === 'from' ? s.from : s.to}</Text>
                  <View style={styles.row}>
                    <Button
                      kind="secondary"
                      label="‹"
                      a11yLabel={`${key === 'from' ? s.from : s.to}: ${s.earlier}`}
                      onPress={() => shift(key, -1)}
                    />
                    <Text style={styles.value}>{dayTitle(form[key], props.locale)}</Text>
                    <Button
                      kind="secondary"
                      label="›"
                      a11yLabel={`${key === 'from' ? s.from : s.to}: ${s.later}`}
                      onPress={() => shift(key, 1)}
                    />
                  </View>
                </View>
              ))}
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
                <Button kind="link" label={s.cancel} onPress={() => setForm(null)} />
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
