import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Location } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { HOLD_MINUTES, messagesChanges, messagesForm, REMINDER_HOURS } from '../messages';
import { saveProblem } from '../salon';
import { Button, Card, colors, ErrorText, Heading, Pressable, switchTouchTarget } from '../ui';
import type { SalonChoice } from './SalonsScreen';
import { SalonReadCache, useScreenLifetime } from './HistoryScreen';

export const locationCache = new SalonReadCache<Location>();

export function useLocationForm<T>(
  api: BusinessApi,
  salon: SalonChoice,
  toForm: (location: Location) => T,
  t: Dictionary,
  setError: (message: string) => void,
) {
  const dictionary = useRef(t);
  dictionary.current = t;
  const [location, setLocation] = useState<Location | null>(null);
  const [form, setForm] = useState<T | null>(null);
  const lifetime = useScreenLifetime(salon);
  const load = useCallback(async () => {
    const signal = lifetime.current!.signal;
    if (signal.aborted) return;
    try {
      const saved = await locationCache.read(salon, () =>
        api.location(salon.orgId, salon.locationId),
      );
      if (signal.aborted) return;
      setLocation(saved);
      setForm(toForm(saved));
    } catch (e) {
      if (!signal.aborted) setError(errorText(e, dictionary.current));
    }
  }, [api, salon, toForm, lifetime, setError]);

  useEffect(() => {
    void load();
  }, [load]);

  return { location, setLocation, form, setForm, lifetime, load };
}

/**
 * Task 208: "Wiadomości do klientów" — the owner or a manager chooses when the reminder email
 * goes, how long a freed time waits for the first person on the waiting list, and switches
 * "Pora na kolejną wizytę" on with the number of days and, if they like, their own words.
 */
export function MessagesScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const m = t.messages;
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const { location, setLocation, form, setForm, lifetime, load } = useLocationForm(
    api,
    salon,
    messagesForm,
    t,
    setError,
  );

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  async function save() {
    if (!location || !form || busy) return;
    setError('');
    setInfo('');
    const checked = messagesChanges(location, form);
    if ('problem' in checked) {
      setError(checked.problem === 'rebookDays' ? m.badDays : m.badText);
      return;
    }
    if (Object.keys(checked.changes).length === 0) {
      setInfo(m.nothing);
      return;
    }
    const signal = lifetime.current!.signal;
    setBusy(true);
    try {
      const saved = await api.updateLocation(
        salon.orgId,
        salon.locationId,
        location.version,
        checked.changes,
      );
      locationCache.set(salon, saved);
      if (signal.aborted) return;
      setLocation(saved);
      setForm(messagesForm(saved));
      setInfo(m.saved);
    } catch (e) {
      locationCache.clear(salon);
      if (signal.aborted) return;
      if (saveProblem(e) === 'changedMeanwhile') {
        setError(m.changedMeanwhile);
        await load();
      } else setError(errorText(e, t));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={m.back} onPress={onBack} />
      </View>
      <Heading>{m.title}</Heading>
      <Text style={styles.muted}>{m.hint}</Text>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {info ? (
        <Text role="status" style={styles.info}>
          {info}
        </Text>
      ) : null}

      {form ? (
        <>
          <Card>
            <Text style={styles.label}>{m.reminder}</Text>
            <View style={styles.row}>
              {REMINDER_HOURS.map((hours) => (
                <Chip
                  key={hours}
                  label={hours === 0 ? m.reminderNone : fill(m.reminderHours, { n: String(hours) })}
                  on={form.reminderHoursBefore === hours}
                  onPress={() => setForm({ ...form, reminderHoursBefore: hours })}
                />
              ))}
            </View>
          </Card>
          <Card>
            <Text style={styles.label}>{m.hold}</Text>
            <View style={styles.row}>
              {HOLD_MINUTES.map((minutes) => (
                <Chip
                  key={minutes}
                  label={minutes === 0 ? m.holdOff : fill(m.holdMinutes, { n: String(minutes) })}
                  on={form.waitlistHoldMinutes === minutes}
                  onPress={() => setForm({ ...form, waitlistHoldMinutes: minutes })}
                />
              ))}
            </View>
            <Text style={styles.small}>{m.holdHint}</Text>
          </Card>
          <Card>
            <Text style={styles.label}>{m.rebook}</Text>
            <View style={styles.switchRow}>
              <Text style={[styles.value, { flex: 1 }]}>{m.rebookOn}</Text>
              <Switch
                style={switchTouchTarget}
                accessibilityLabel={m.rebookOn}
                value={form.rebookOn}
                onValueChange={(rebookOn) => setForm({ ...form, rebookOn })}
                trackColor={{ true: colors.accent, false: colors.line }}
              />
            </View>
            {form.rebookOn ? (
              <>
                <TextInput
                  accessibilityLabel={m.rebookDays}
                  placeholder={m.rebookDays}
                  placeholderTextColor={colors.placeholder}
                  value={form.rebookDays}
                  onChangeText={(rebookDays) => setForm({ ...form, rebookDays })}
                  keyboardType="number-pad"
                  maxLength={3}
                  style={styles.input}
                />
                <TextInput
                  accessibilityLabel={m.rebookText}
                  placeholder={m.rebookPlaceholder}
                  placeholderTextColor={colors.placeholder}
                  value={form.rebookText}
                  onChangeText={(rebookText) => setForm({ ...form, rebookText })}
                  maxLength={500}
                  multiline
                  numberOfLines={3}
                  style={[styles.input, styles.multiline]}
                />
              </>
            ) : null}
            <Text style={styles.small}>{m.rebookHint}</Text>
          </Card>
          <Button label={m.save} busy={busy} onPress={() => void save()} />
        </>
      ) : !error ? (
        <Text style={styles.muted}>{t.loading}</Text>
      ) : null}
    </ScrollView>
  );
}

function Chip(props: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      aria-pressed={props.on}
      accessibilityState={{ selected: props.on }}
      onPress={props.onPress}
      style={[styles.chip, props.on && styles.chipOn]}
    >
      <Text style={[styles.chipText, props.on && { color: '#fff' }]}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  switchRow: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  label: { fontSize: 13, fontWeight: '700', color: colors.muted },
  value: { fontSize: 15, color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  info: { color: '#2e7d32', fontSize: 15 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.ink,
  },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  chip: {
    maxWidth: '100%',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 15, color: colors.ink },
});
