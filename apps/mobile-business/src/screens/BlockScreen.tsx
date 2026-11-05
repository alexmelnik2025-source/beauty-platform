import { useEffect, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type BusinessApi, type Locale } from '../api';
import { localToIso, nextFullHour, shiftTime } from '../blocks';
import { dayTitle } from '../day';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { Button, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

const STEP = 15;

/**
 * Block time on one day: whose time (a specialist, or the whole salon for an owner or manager),
 * from–to in 15-minute steps and a reason. The server refuses when visits are in the way.
 */
export function BlockScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  date: string;
  today: string;
  timeZone: string;
  targets: { staffId: string | null; name: string | null }[];
  onBack: () => void;
  onSaved: () => void;
}) {
  const { api, t, salon, date, onBack } = props;
  const b = t.blocks;
  const startAt = props.date === props.today ? nextFullHour(props.timeZone) : '12:00';
  const [staffId, setStaffId] = useState<string | null>(
    props.targets.find((x) => x.staffId !== null)?.staffId ?? props.targets[0]?.staffId ?? null,
  );
  const [from, setFrom] = useState(startAt);
  const [to, setTo] = useState(shiftTime(startAt, 60));
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  async function save() {
    if (to <= from) {
      setError(b.badRange);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const text = reason.trim();
      await api.addTimeBlock(salon.orgId, salon.locationId, {
        staffId,
        start: localToIso(date, from, props.timeZone),
        end: localToIso(date, to, props.timeZone),
        ...(text ? { reason: text } : {}),
      });
      props.onSaved();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'APPOINTMENTS_IN_THE_WAY'
          ? b.inTheWay
          : errorText(e, t),
      );
    } finally {
      setBusy(false);
    }
  }

  const stepper = (
    label: string,
    value: string,
    set: (v: string) => void,
    min: string,
    max: string,
  ) => (
    <View style={styles.stepper}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <Button
          kind="secondary"
          label="‹"
          a11yLabel={`${label}: ${b.earlier}`}
          disabled={value <= min}
          onPress={() => set(shiftTime(value, -STEP))}
        />
        <Text style={styles.time} accessibilityLabel={`${label} ${value}`}>
          {value}
        </Text>
        <Button
          kind="secondary"
          label="›"
          a11yLabel={`${label}: ${b.later}`}
          disabled={value >= max}
          onPress={() => set(shiftTime(value, STEP))}
        />
      </View>
    </View>
  );

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={t.schedule.back} onPress={onBack} />
      </View>
      <Heading>{b.add}</Heading>
      <Text style={styles.muted}>{dayTitle(date, props.locale)}</Text>

      {props.targets.length > 1 ? (
        <>
          <Text style={styles.label}>{b.who}</Text>
          <View style={styles.row}>
            {props.targets.map((target) => (
              <Button
                key={target.staffId ?? 'salon'}
                kind={target.staffId === staffId ? 'primary' : 'secondary'}
                label={target.name ?? b.wholeSalon}
                onPress={() => setStaffId(target.staffId)}
              />
            ))}
          </View>
        </>
      ) : null}

      {stepper(b.from, from, setFrom, '00:00', '23:45')}
      {stepper(b.to, to, setTo, '00:15', '24:00')}

      <TextInput
        accessibilityLabel={b.reason}
        placeholder={b.reason}
        placeholderTextColor={colors.placeholder}
        value={reason}
        onChangeText={setReason}
        maxLength={200}
        style={styles.input}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <View style={styles.row}>
        <Button label={b.save} busy={busy} onPress={() => void save()} />
        <Button kind="secondary" label={b.cancel} disabled={busy} onPress={onBack} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  stepper: { gap: 6 },
  label: { marginTop: 8, fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  time: { fontSize: 24, fontWeight: '700', color: colors.ink, minWidth: 80, textAlign: 'center' },
  muted: { color: colors.muted, fontSize: 15 },
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
});
