import { useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type BusinessApi, type Locale } from '../api';
import { localToIso, nextFullHour, seriesDoneText, SERIES_WEEKS, shiftTime } from '../blocks';
import { dayTitle } from '../day';
import { errorText } from '../errors';
import { useClearFormDraft, useFormDraft } from '../formDrafts';
import { fill, type Dictionary } from '../i18n';
import { Button, colors, ErrorText, Heading, Pressable } from '../ui';
import type { SalonChoice } from './SalonsScreen';

const STEP = 15;
type BlockField = 'staffId' | 'start' | 'end' | 'weeks' | 'reason';
type FieldErrors = Partial<Record<BlockField, string>>;

function ChoiceButton(props: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected, disabled: props.disabled }}
      aria-pressed={props.selected}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.choice, props.selected && styles.selectedChoice]}
    >
      <Text style={[styles.choiceLabel, props.selected && styles.selectedLabel]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function fieldError(field: BlockField, message?: string) {
  return message ? (
    <View nativeID={`block-${field}-error`}>
      <ErrorText>! {message}</ErrorText>
    </View>
  ) : null;
}

/**
 * Block time on one day: whose time (a specialist, or the whole salon for an owner or manager),
 * from–to in 15-minute steps and a reason. The server refuses when visits are in the way.
 * Task 342: "Powtarzaj co tydzień" — the same time for 2–26 weeks; days with visits stay free
 * and are named after saving.
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
  /** What to tell the person on the day screen. */
  onSaved: (message: string) => void;
}) {
  const { api, t, salon, date, onBack } = props;
  const b = t.blocks;
  const [staffId, setStaffId] = useState<string | null>(
    () =>
      props.targets.find((x) => x.staffId !== null)?.staffId ?? props.targets[0]?.staffId ?? null,
  );
  const [from, setFrom] = useState(() =>
    date === props.today ? nextFullHour(props.timeZone) : '12:00',
  );
  const [to, setTo] = useState(() => shiftTime(from, 60));
  const draftKey = `block.${salon.locationId}.${date}.`;
  const [reason, setReason] = useFormDraft(`${draftKey}reason`, '');
  const clearDraft = useClearFormDraft(draftKey);
  const [weekly, setWeekly] = useState(false);
  const [weeks, setWeeks] = useState<number>(SERIES_WEEKS.start);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [fields, setFields] = useState<FieldErrors>({});
  const endError = submitted && to <= from ? b.badRange : fields.end;
  const reasonError = submitted && !reason.trim() ? b.reason : fields.reason;
  const [busy, setBusy] = useState(false);

  const saving = useRef(false);
  const title = useMemo(() => dayTitle(date, props.locale), [date, props.locale]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!saving.current) onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  function clearField(field: BlockField) {
    setFields((previous) => {
      const next = { ...previous };
      delete next[field];
      if (field === 'start' && previous.end === b.badRange) delete next.end;
      if ((field === 'start' || field === 'staffId') && previous.end === b.inTheWay)
        delete next.end;
      return next;
    });
  }

  async function save() {
    if (saving.current) return;
    setSubmitted(true);
    setError('');
    setFields({});
    if (to <= from || !reason.trim()) return;
    saving.current = true;
    setBusy(true);
    try {
      const body = {
        staffId,
        start: localToIso(date, from, props.timeZone),
        end: localToIso(date, to, props.timeZone),
        reason: reason.trim(),
      };
      let message = b.added;
      if (weekly) {
        const made = await api.addTimeBlockSeries(salon.orgId, salon.locationId, {
          ...body,
          weeks,
        });
        message = seriesDoneText(made, t);
      } else {
        await api.addTimeBlock(salon.orgId, salon.locationId, body);
      }
      clearDraft();
      props.onSaved(message);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'APPOINTMENTS_IN_THE_WAY') {
        setFields({ end: b.inTheWay });
      } else if (e instanceof ApiError && e.code === 'VALIDATION_ERROR') {
        const issues: FieldErrors = {};
        for (const { path } of e.details) {
          if (path === '') issues.end = b.badRange;
          if (
            path === 'start' ||
            path === 'end' ||
            path === 'reason' ||
            (path === 'weeks' && weekly) ||
            (path === 'staffId' && props.targets.length > 1)
          ) {
            issues[path] = t.error.generic;
          }
        }
        setFields(issues);
        if (!Object.keys(issues).length) setError(errorText(e, t));
      } else {
        setError(errorText(e, t));
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  const stepper = (
    label: string,
    value: string,
    set: (v: string) => void,
    min: string,
    max: string,
    field: 'start' | 'end',
    message?: string,
  ) => (
    <View style={styles.stepper}>
      <Text style={styles.label}>{label}</Text>
      <View
        role="group"
        accessibilityLabel={label}
        aria-invalid={!!message}
        aria-describedby={message ? `block-${field}-error` : undefined}
        style={[styles.row, message && styles.invalidRange]}
      >
        <Button
          kind="secondary"
          label="‹"
          a11yLabel={`${label}: ${b.earlier}`}
          disabled={busy || value <= min}
          onPress={() => {
            set(shiftTime(value, -STEP));
            clearField(field);
          }}
        />
        <Text style={styles.time} accessibilityLabel={`${label} ${value}`}>
          {value}
        </Text>
        <Button
          kind="secondary"
          label="›"
          a11yLabel={`${label}: ${b.later}`}
          disabled={busy || value >= max}
          onPress={() => {
            set(shiftTime(value, STEP));
            clearField(field);
          }}
        />
      </View>
      {fieldError(field, message)}
    </View>
  );

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={t.schedule.back} disabled={busy} onPress={onBack} />
      </View>
      <Heading>{b.add}</Heading>
      <Text style={styles.muted}>{title}</Text>

      {props.targets.length > 1 ? (
        <>
          <Text style={styles.label}>{b.who}</Text>
          <View
            role="group"
            accessibilityLabel={b.who}
            aria-invalid={!!fields.staffId}
            aria-describedby={fields.staffId ? 'block-staffId-error' : undefined}
            style={[styles.row, fields.staffId && styles.invalidRange]}
          >
            {props.targets.map((target) => (
              <ChoiceButton
                key={target.staffId ?? 'salon'}
                selected={target.staffId === staffId}
                label={target.name ?? b.wholeSalon}
                disabled={busy}
                onPress={() => {
                  setStaffId(target.staffId);
                  clearField('staffId');
                }}
              />
            ))}
          </View>
          {fieldError('staffId', fields.staffId)}
        </>
      ) : null}

      {stepper(b.from, from, setFrom, '00:00', '23:45', 'start', fields.start)}
      {stepper(b.to, to, setTo, '00:15', '24:00', 'end', endError)}

      <View style={styles.row}>
        <ChoiceButton
          selected={!weekly}
          label={b.once}
          disabled={busy}
          onPress={() => {
            setWeekly(false);
            clearField('weeks');
          }}
        />
        <ChoiceButton
          selected={weekly}
          label={b.repeat}
          disabled={busy}
          onPress={() => setWeekly(true)}
        />
      </View>
      {weekly ? (
        <View style={styles.stepper}>
          <Text style={styles.label}>{b.weeks}</Text>
          <View
            role="group"
            accessibilityLabel={b.weeks}
            aria-invalid={!!fields.weeks}
            aria-describedby={fields.weeks ? 'block-weeks-error' : undefined}
            style={[styles.row, fields.weeks && styles.invalidRange]}
          >
            <Button
              kind="secondary"
              label="‹"
              a11yLabel={b.fewerWeeks}
              disabled={busy || weeks <= SERIES_WEEKS.min}
              onPress={() => {
                setWeeks(weeks - 1);
                clearField('weeks');
              }}
            />
            <Text style={styles.time}>{fill(b.weeksCount, { count: String(weeks) })}</Text>
            <Button
              kind="secondary"
              label="›"
              a11yLabel={b.moreWeeks}
              disabled={busy || weeks >= SERIES_WEEKS.max}
              onPress={() => {
                setWeeks(weeks + 1);
                clearField('weeks');
              }}
            />
          </View>
          {fieldError('weeks', fields.weeks)}
          <Text style={styles.muted}>{b.repeatHint}</Text>
        </View>
      ) : null}

      <View style={styles.stepper}>
        <Text style={styles.label}>{b.reason}</Text>
        <TextInput
          accessibilityLabel={b.reason}
          accessibilityHint={reasonError}
          aria-invalid={!!reasonError}
          aria-describedby={reasonError ? 'block-reason-error' : undefined}
          value={reason}
          editable={!busy}
          onChangeText={(value) => {
            setReason(value);
            clearField('reason');
          }}
          maxLength={200}
          style={[styles.input, reasonError && styles.invalidInput]}
        />
        {fieldError('reason', reasonError)}
      </View>
      {error ? <ErrorText>{error}</ErrorText> : null}
      <View style={styles.row}>
        <Button label={b.save} busy={busy} onPress={() => void save()} />
        <Button
          kind="secondary"
          label={b.cancel}
          disabled={busy}
          onPress={() => {
            clearDraft();
            onBack();
          }}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  stepper: { gap: 6 },
  choice: {
    maxWidth: '100%',
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  selectedChoice: { backgroundColor: colors.ink, borderColor: colors.ink },
  choiceLabel: {
    maxWidth: '100%',
    color: colors.ink,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  selectedLabel: { color: colors.card },
  invalidRange: { borderWidth: 1, borderColor: colors.danger, borderRadius: 12 },
  invalidInput: { borderColor: colors.danger },
  label: { marginTop: 8, fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  time: { fontSize: 24, fontWeight: '700', color: colors.ink, minWidth: 80, textAlign: 'center' },
  muted: { color: colors.muted, fontSize: 15 },
  input: {
    minHeight: 44,
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
