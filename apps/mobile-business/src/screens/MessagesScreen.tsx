import { useCallback, useEffect, useState } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { BusinessApi, Location } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  HOLD_MINUTES,
  messagesChanges,
  messagesForm,
  REMINDER_HOURS,
  type MessagesForm,
} from '../messages';
import { saveProblem } from '../salon';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

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
  const [location, setLocation] = useState<Location | null>(null);
  const [form, setForm] = useState<MessagesForm | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const saved = await api.location(salon.orgId, salon.locationId);
      setLocation(saved);
      setForm(messagesForm(saved));
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, t]);

  useEffect(() => {
    void load();
  }, [load]);

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
    setBusy(true);
    try {
      const saved = await api.updateLocation(
        salon.orgId,
        salon.locationId,
        location.version,
        checked.changes,
      );
      setLocation(saved);
      setForm(messagesForm(saved));
      setInfo(m.saved);
    } catch (e) {
      if (saveProblem(e) === 'changedMeanwhile') {
        setError(m.changedMeanwhile);
        await load();
      } else setError(errorText(e, t));
    } finally {
      setBusy(false);
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
