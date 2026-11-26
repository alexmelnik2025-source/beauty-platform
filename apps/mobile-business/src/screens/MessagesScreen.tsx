import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { BusinessApi, Location } from '../api';
import { errorText } from '../errors';
import { useFormDraft } from '../formDrafts';
import { fill, type Dictionary } from '../i18n';
import {
  HOLD_MINUTES,
  messagesChanges,
  messagesForm,
  REMINDER_HOURS,
  type MessagesForm,
  type MessagesProblem,
} from '../messages';
import { saveProblem } from '../salon';
import { Button, Card, colors, ErrorText, Heading, Pressable, switchTouchTarget } from '../ui';
import type { SalonChoice } from './SalonsScreen';
import {
  LoadingSkeleton,
  SalonReadCache,
  useScreenLifetime,
  withNetworkTimeout,
} from './HistoryScreen';

export const locationCache = new SalonReadCache<Location>();

type MessageEdits = Partial<MessagesForm> & { customText?: boolean };
const noEdits: MessageEdits = {};

function changedFields(edits: MessageEdits, saved: MessagesForm): MessageEdits {
  const changes = { ...edits };
  for (const key of Object.keys(saved) as (keyof MessagesForm)[]) {
    if (changes[key] === saved[key]) delete changes[key];
  }
  // Switching custom text off still hides a typed template until the switch is turned on again.
  const hidesDraftText = changes.customText === false && changes.rebookText !== undefined;
  if (!hidesDraftText && changes.customText === Boolean(saved.rebookText))
    delete changes.customText;
  return changes;
}

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
      const saved = await locationCache.read(
        salon,
        () => api.location(salon.orgId, salon.locationId),
        undefined,
        signal,
      );
      if (signal.aborted) return;
      setLocation(saved);
      setForm(toForm(saved));
      return saved;
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
  const [edits, setEdits] = useFormDraft(`messages.${salon.orgId}.${salon.locationId}`, noEdits);
  const [fieldError, setFieldError] = useState<MessagesProblem | 'emptyText' | null>(null);
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);

  const {
    location,
    setLocation,
    form: savedForm,
    setForm,
    lifetime,
    load,
  } = useLocationForm(api, salon, messagesForm, t, setError);
  const form = savedForm && { ...savedForm, ...edits };
  const edit = useCallback(
    (fields: MessageEdits) =>
      setEdits((previous) => {
        const next = { ...previous, ...fields };
        return savedForm && !saving.current ? changedFields(next, savedForm) : next;
      }),
    [savedForm, setEdits],
  );

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const customTextEnabled =
    edits.customText ?? (edits.rebookText !== undefined || Boolean(location?.rebookReminderText));
  const invalidDays = fieldError === 'rebookDays';
  const invalidText = fieldError === 'emptyText' || fieldError === 'rebookText';
  const textError =
    fieldError === 'emptyText' ? fill(t.salon.missing, { list: m.rebook }) : m.badText;

  async function save() {
    if (!location || !form || saving.current) return;
    setError('');
    setInfo('');
    setFieldError(null);
    const checked = messagesChanges(
      location,
      customTextEnabled ? form : { ...form, rebookText: '' },
    );
    if ('problem' in checked) {
      setFieldError(checked.problem);
      return;
    }
    if (form.rebookOn && customTextEnabled && !form.rebookText.trim()) {
      setFieldError('emptyText');
      return;
    }
    if (Object.keys(checked.changes).length === 0) {
      setEdits(noEdits);
      setInfo(m.nothing);
      return;
    }

    function clearSubmittedEdits(saved: Location) {
      setEdits((latest) => {
        if (latest === edits) return noEdits;
        // The person may have continued typing while the request was in flight.
        const remaining = { ...latest };
        for (const field of Object.keys(edits) as (keyof MessageEdits)[]) {
          if (remaining[field] === edits[field]) delete remaining[field];
        }
        return changedFields(remaining, messagesForm(saved));
      });
    }

    const signal = lifetime.current!.signal;
    saving.current = true;
    setBusy(true);
    try {
      // A screen reopened during the write must load the resulting version of the salon.
      locationCache.clear(salon);
      const saved = await locationCache.read(salon, () =>
        withNetworkTimeout(
          api.updateLocation(salon.orgId, salon.locationId, location.version, checked.changes),
        ),
      );
      clearSubmittedEdits(saved);
      if (signal.aborted) return;
      setLocation(saved);
      setForm(messagesForm(saved));
      setInfo(m.saved);
    } catch (e) {
      if (signal.aborted) return;
      if (saveProblem(e) === 'changedMeanwhile') {
        setError(m.changedMeanwhile);
        const current = await load();
        if (current) clearSubmittedEdits(current);
      } else setError(errorText(e, t));
    } finally {
      saving.current = false;
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
      {error ? (
        <>
          <ErrorText>{error}</ErrorText>
          {!form && (
            <Button
              kind="secondary"
              label={t.day.refresh}
              onPress={() => {
                setError('');
                void load();
              }}
            />
          )}
        </>
      ) : null}
      {info ? (
        <Text role="status" style={styles.info}>
          {info}
        </Text>
      ) : null}

      {form ? (
        <>
          <TimingSettings
            m={m}
            reminderHoursBefore={form.reminderHoursBefore}
            waitlistHoldMinutes={form.waitlistHoldMinutes}
            edit={edit}
          />
          <Card>
            <Text style={styles.label}>{m.rebook}</Text>
            <View style={styles.switchRow}>
              <Text aria-hidden style={styles.switchLabel}>
                {m.rebookOn}
              </Text>
              <Switch
                style={switchTouchTarget}
                accessibilityLabel={m.rebookOn}
                value={form.rebookOn}
                onValueChange={(rebookOn) => {
                  setFieldError(null);
                  edit({ rebookOn });
                }}
                trackColor={{ true: colors.accent, false: colors.line }}
              />
            </View>
            {form.rebookOn ? (
              <>
                <Text style={styles.label}>{m.rebookDays}</Text>
                <TextInput
                  accessibilityLabel={m.rebookDays}
                  aria-invalid={invalidDays}
                  accessibilityHint={invalidDays ? m.badDays : undefined}
                  aria-describedby={invalidDays ? 'rebook-days-error' : undefined}
                  value={form.rebookDays}
                  onChangeText={(rebookDays) => {
                    if (invalidDays) setFieldError(null);
                    edit({ rebookDays });
                  }}
                  keyboardType="number-pad"
                  maxLength={3}
                  style={[styles.input, invalidDays && styles.invalid]}
                />
                {invalidDays && (
                  <View nativeID="rebook-days-error">
                    <ErrorText>! {m.badDays}</ErrorText>
                  </View>
                )}
                <View style={styles.switchRow}>
                  <Text aria-hidden style={styles.switchLabel}>
                    {m.rebookText}
                  </Text>
                  <Switch
                    style={switchTouchTarget}
                    accessibilityLabel={m.rebookText}
                    value={customTextEnabled}
                    onValueChange={(enabled) => {
                      if (invalidText) setFieldError(null);
                      edit({ customText: enabled });
                    }}
                    trackColor={{ true: colors.accent, false: colors.line }}
                  />
                </View>
                {customTextEnabled && (
                  <TextInput
                    accessibilityLabel={m.rebookText}
                    aria-invalid={invalidText}
                    accessibilityHint={invalidText ? textError : undefined}
                    aria-describedby={invalidText ? 'rebook-text-error' : undefined}
                    placeholder={m.rebookPlaceholder}
                    placeholderTextColor={colors.placeholder}
                    value={form.rebookText}
                    onChangeText={(rebookText) => {
                      if (invalidText) setFieldError(null);
                      edit({ customText: true, rebookText });
                    }}
                    maxLength={500}
                    multiline
                    scrollEnabled={false}
                    style={[styles.input, styles.multiline, invalidText && styles.invalid]}
                  />
                )}
                {customTextEnabled && invalidText && (
                  <View nativeID="rebook-text-error">
                    <ErrorText>! {textError}</ErrorText>
                  </View>
                )}
              </>
            ) : null}
            <Text style={styles.small}>{m.rebookHint}</Text>
          </Card>
          <Button label={m.save} busy={busy} onPress={() => void save()} />
        </>
      ) : !error ? (
        <LoadingSkeleton label={t.loading} />
      ) : null}
    </ScrollView>
  );
}

const TimingSettings = memo(function TimingSettings({
  m,
  reminderHoursBefore,
  waitlistHoldMinutes,
  edit,
}: {
  m: Dictionary['messages'];
  reminderHoursBefore: number;
  waitlistHoldMinutes: number;
  edit: (fields: MessageEdits) => void;
}) {
  return (
    <>
      <Card>
        <Text style={styles.label}>{m.reminder}</Text>
        <View role="group" accessibilityLabel={m.reminder} style={styles.row}>
          {REMINDER_HOURS.map((hours) => (
            <Chip
              key={hours}
              label={hours === 0 ? m.reminderNone : fill(m.reminderHours, { n: String(hours) })}
              on={reminderHoursBefore === hours}
              onPress={() => edit({ reminderHoursBefore: hours })}
            />
          ))}
        </View>
      </Card>
      <Card>
        <Text style={styles.label}>{m.hold}</Text>
        <View role="group" accessibilityLabel={m.hold} style={styles.row}>
          {HOLD_MINUTES.map((minutes) => (
            <Chip
              key={minutes}
              label={minutes === 0 ? m.holdOff : fill(m.holdMinutes, { n: String(minutes) })}
              on={waitlistHoldMinutes === minutes}
              onPress={() => edit({ waitlistHoldMinutes: minutes })}
            />
          ))}
        </View>
        <Text style={styles.small}>{m.holdHint}</Text>
      </Card>
    </>
  );
});

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
  switchLabel: { flex: 1, minWidth: 0, fontSize: 15, color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  info: { color: '#2e7d32', fontSize: 15 },
  input: {
    minHeight: 44,
    minWidth: 44,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.ink,
  },
  invalid: { borderColor: colors.danger },
  multiline: {
    minHeight: 80,
    textAlignVertical: 'top',
    ...Platform.select({ web: { fieldSizing: 'content' } }),
  },
  chip: {
    maxWidth: '100%',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 15, color: colors.ink },
});
