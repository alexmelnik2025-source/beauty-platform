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
  SLOT_STEPS,
  salonChanges,
  salonForm,
  saveProblem,
  type SalonForm,
  type SalonProblem,
} from '../salon';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * "Salon" (task 131): the owner or a manager changes the salon's name, address, phone and
 * description and switches online booking on or off. Opening hours, prices and the booking
 * terms stay in their own places (the team's schedule, "Usługi", the salon dashboard).
 * Task 319: "Zasady rezerwacji" — the lead time, how far ahead, the change deadline, the step.
 */
export function SalonScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  onBack: () => void;
  /** The salon's name changed: the calendar's header shows the new one. */
  onRenamed: (name: string) => void;
}) {
  const { api, t, salon, onBack, onRenamed } = props;
  const s = t.salon;
  const [location, setLocation] = useState<Location | null>(null);
  const [form, setForm] = useState<SalonForm | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const saved = await api.location(salon.orgId, salon.locationId);
      setLocation(saved);
      setForm(salonForm(saved));
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Android "back" closes the salon's settings instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const problems: Record<SalonProblem, string> = {
    name: s.badName,
    address: s.badAddress,
    city: s.badCity,
    postalCode: s.badPostalCode,
    phone: s.badPhone,
    lead: s.badLead,
    horizon: s.badHorizon,
    deadline: s.badDeadline,
  };

  async function save() {
    if (!location || !form || busy) return;
    setError('');
    setInfo('');
    const checked = salonChanges(location, form);
    if ('problem' in checked) {
      setError(problems[checked.problem]);
      return;
    }
    if (Object.keys(checked.changes).length === 0) {
      setInfo(s.nothing);
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
      setForm(salonForm(saved));
      setInfo(s.saved);
      if (saved.name !== location.name) onRenamed(saved.name);
    } catch (e) {
      const problem = saveProblem(e);
      if (problem === 'legalTexts') setError(s.legalTexts);
      else if (problem === 'changedMeanwhile') {
        setError(s.changedMeanwhile);
        await load();
      } else setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  const field = (
    key:
      | 'name'
      | 'addressLine'
      | 'city'
      | 'postalCode'
      | 'phone'
      | 'minLeadMinutes'
      | 'bookingHorizonDays'
      | 'clientCancelDeadlineMinutes',
    label: string,
    options: { maxLength: number; keyboardType?: 'phone-pad' | 'number-pad'; hint?: string },
  ) =>
    form ? (
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <TextInput
          accessibilityLabel={label}
          value={form[key]}
          maxLength={options.maxLength}
          keyboardType={options.keyboardType}
          onChangeText={(value) => setForm({ ...form, [key]: value })}
          style={styles.input}
        />
        {options.hint ? <Text style={styles.small}>{options.hint}</Text> : null}
      </View>
    ) : null;

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={s.back} onPress={onBack} />
      </View>
      <Heading>{s.title}</Heading>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {info ? <Text style={styles.info}>{info}</Text> : null}

      {form ? (
        <>
          <Card>
            <View style={styles.switchRow}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.value}>{s.online}</Text>
                <Text style={styles.small}>
                  {form.onlineBookingEnabled ? s.onlineOn : s.onlineOff}
                </Text>
              </View>
              <Switch
                accessibilityLabel={s.online}
                value={form.onlineBookingEnabled}
                onValueChange={(onlineBookingEnabled) => setForm({ ...form, onlineBookingEnabled })}
                trackColor={{ true: colors.accent, false: colors.line }}
              />
            </View>
          </Card>
          <Card>
            {field('name', s.name, { maxLength: 100 })}
            {field('addressLine', s.address, { maxLength: 200 })}
            {field('city', s.city, { maxLength: 100 })}
            {field('postalCode', s.postalCode, { maxLength: 12 })}
            {field('phone', s.phone, {
              maxLength: 20,
              keyboardType: 'phone-pad',
              hint: s.phoneHint,
            })}
            <View style={styles.field}>
              <Text style={styles.label}>{s.description}</Text>
              <TextInput
                accessibilityLabel={s.description}
                value={form.description}
                maxLength={1000}
                multiline
                numberOfLines={4}
                onChangeText={(description) => setForm({ ...form, description })}
                style={[styles.input, styles.multiline]}
              />
              <Text style={styles.small}>{s.descriptionHint}</Text>
            </View>
          </Card>
          <Card>
            <Text style={styles.section}>{s.rules}</Text>
            {field('minLeadMinutes', s.lead, {
              maxLength: 5,
              keyboardType: 'number-pad',
              hint: s.leadHint,
            })}
            {field('bookingHorizonDays', s.horizon, { maxLength: 3, keyboardType: 'number-pad' })}
            {field('clientCancelDeadlineMinutes', s.deadline, {
              maxLength: 5,
              keyboardType: 'number-pad',
              hint: s.deadlineHint,
            })}
            <View style={styles.field}>
              <Text style={styles.label}>{s.step}</Text>
              <View style={styles.row}>
                {SLOT_STEPS.map((minutes) => (
                  <Chip
                    key={minutes}
                    label={fill(s.stepMinutes, { n: String(minutes) })}
                    on={form.slotStepMinutes === minutes}
                    onPress={() => setForm({ ...form, slotStepMinutes: minutes })}
                  />
                ))}
              </View>
              <Text style={styles.small}>{s.stepHint}</Text>
            </View>
          </Card>
          <Button label={s.save} busy={busy} onPress={() => void save()} />
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
  field: { gap: 4, marginBottom: 10 },
  label: { fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  value: { fontSize: 16, color: colors.ink, fontWeight: '600' },
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
  multiline: { minHeight: 96, textAlignVertical: 'top' },
  section: { fontSize: 16, color: colors.ink, fontWeight: '700', marginBottom: 10 },
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
