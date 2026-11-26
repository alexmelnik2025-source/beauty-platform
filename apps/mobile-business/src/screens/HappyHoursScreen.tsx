import { useFormDraft } from '../formDrafts';
import { FormField } from '../formFields';
import { useCallback, useEffect, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Locale } from '../api';
import { errorText } from '../errors';
import {
  daysText,
  namesText,
  newLastMinuteRule,
  newRule,
  rulesToSave,
  shortWeekday,
  type Rule,
} from '../happyHours';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
import type { SalonChoice } from './SalonsScreen';

const WEEK = [1, 2, 3, 4, 5, 6, 7];
const EMPTY_FORM = {
  weekdays: [] as number[],
  start: '',
  hours: '',
  end: '',
  percent: '',
  staffIds: [] as string[],
};

type PromotionDraft = typeof EMPTY_FORM & { kind: 'hours' | 'lastMinute' };

/**
 * Task 99: "Happy hours" — the owner or a manager sees the salon's cheaper hours, adds one
 * (days, from–to, discount, optionally some specialists) and removes one from the phone.
 * Services stay "all" here; a rule for some services only is set in the cabinet.
 */
export function HappyHoursScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const h = t.happyHours;
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [staffNames, setStaffNames] = useState(new Map<string, string>());
  const [serviceNames, setServiceNames] = useState(new Map<string, string>());
  const [staffOrder, setStaffOrder] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [info, setInfo] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [problem, setProblem] = useState<
    import('../happyHours').RuleProblem | 'lastMinuteHours' | null
  >(null);
  const [form, setForm, resetForm] = useFormDraft<PromotionDraft | null>('promotion.form', null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [hours, staff, services] = await Promise.all([
        api.happyHours(salon.orgId, salon.locationId),
        api.staff(salon.orgId, salon.locationId),
        api.services(salon.orgId, salon.locationId),
      ]);
      setRules(hours.rules);
      setStaffNames(new Map(staff.map((s) => [s.id, s.displayName])));
      setServiceNames(new Map(services.map((s) => [s.id, s.name])));
      setStaffOrder(
        staff
          .filter((s) => s.active)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((s) => ({ id: s.id, name: s.displayName })),
      );
    } catch (e) {
      setLoadError(errorText(e, t));
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

  async function save(next: ReturnType<typeof rulesToSave>, done: string, onSuccess?: () => void) {
    setBusy(true);
    try {
      const saved = await api.saveHappyHours(salon.orgId, salon.locationId, next);
      setRules(saved.rules);
      setInfo(done);
      setError('');
      onSuccess?.();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  function add() {
    if (!form || !rules || busy) return;
    setError('');
    setProblem(null);
    const checked = form.kind === 'lastMinute' ? newLastMinuteRule(form) : newRule(form);
    if (!checked.ok) {
      setProblem(checked.problem);
      return;
    }
    void save(
      rulesToSave(rules, { add: checked.rule }),
      form.kind === 'lastMinute' ? h.promotionSaved : h.saved,
      resetForm,
    );
  }

  const summary = (rule: Rule) =>
    rule.kind === 'lastMinute' && rule.lastMinuteHours !== null
      ? fill(h.lastMinuteSummary, { hours: String(rule.lastMinuteHours) })
      : `${daysText(rule.weekdays, props.locale, h.everyDay)} · ${rule.start}–${rule.end}`;

  function startForm(kind: PromotionDraft['kind']) {
    setForm({ ...EMPTY_FORM, kind });
    setChoosing(false);
    setProblem(null);
    setError('');
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={h.back} onPress={onBack} />
      </View>
      <Heading>{h.title}</Heading>
      {info ? (
        <Text role="status" style={styles.info}>
          {info}
        </Text>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {loadError ? (
        <>
          <ErrorText>{loadError}</ErrorText>
          {rules === null ? <Button kind="secondary" label={t.day.refresh} onPress={load} /> : null}
        </>
      ) : null}

      {form ? (
        <Card>
          <Text style={styles.name}>{form.kind === 'lastMinute' ? h.lastMinute : h.scheduled}</Text>
          {form.kind === 'lastMinute' ? (
            <>
              <FormField
                error={problem === 'lastMinuteHours' ? h.badLastMinuteHours : undefined}
                accessibilityLabel={h.lastMinuteHours}
                placeholder={h.lastMinuteHours}
                placeholderTextColor={colors.placeholder}
                value={form.hours}
                onChangeText={(hours) => {
                  setProblem(null);
                  setForm({ ...form, hours });
                }}
                keyboardType="number-pad"
                style={styles.input}
              />
            </>
          ) : (
            <>
              <Text style={styles.label}>{h.days}</Text>
              <View style={styles.row}>
                {WEEK.map((d) => {
                  const on = form.weekdays.includes(d);
                  return (
                    <Chip
                      key={d}
                      label={shortWeekday(d, props.locale)}
                      on={on}
                      onPress={() => setForm({ ...form, weekdays: toggled(form.weekdays, d) })}
                    />
                  );
                })}
              </View>
              {problem === 'days' ? <ErrorText>! {h.problem.days}</ErrorText> : null}
              <View style={styles.row}>
                <TextInput
                  accessibilityLabel={h.start}
                  placeholder={h.start}
                  placeholderTextColor={colors.placeholder}
                  value={form.start}
                  onChangeText={(start) => setForm({ ...form, start })}
                  keyboardType="numbers-and-punctuation"
                  style={[styles.input, { flex: 1 }]}
                />
                <FormField
                  containerStyle={{ flex: 1 }}
                  error={
                    problem === 'clock' || problem === 'hours' ? h.problem[problem] : undefined
                  }
                  accessibilityLabel={h.end}
                  placeholder={h.end}
                  placeholderTextColor={colors.placeholder}
                  value={form.end}
                  onChangeText={(end) => setForm({ ...form, end })}
                  keyboardType="numbers-and-punctuation"
                  style={[styles.input, { flex: 1 }]}
                />
              </View>
            </>
          )}
          <FormField
            error={problem === 'percent' ? h.problem.percent : undefined}
            accessibilityLabel={h.percent}
            placeholder={h.percent}
            placeholderTextColor={colors.placeholder}
            value={form.percent}
            onChangeText={(percent) => setForm({ ...form, percent })}
            keyboardType="number-pad"
            style={styles.input}
          />
          {staffOrder.length > 0 ? (
            <>
              <Text style={styles.label}>{h.staff}</Text>
              <View style={styles.row}>
                {staffOrder.map((s) => (
                  <Chip
                    key={s.id}
                    label={s.name}
                    on={form.staffIds.includes(s.id)}
                    onPress={() => setForm({ ...form, staffIds: toggled(form.staffIds, s.id) })}
                  />
                ))}
              </View>
              <Text style={styles.muted}>{h.staffHint}</Text>
            </>
          ) : null}
          <Text style={styles.muted}>{h.onlyNew}</Text>
          <View style={styles.row}>
            <Button label={h.save} busy={busy} disabled={rules === null} onPress={add} />
            <Button
              kind="secondary"
              label={h.cancel}
              onPress={() => {
                resetForm();
                setProblem(null);
                setError('');
              }}
            />
          </View>
        </Card>
      ) : choosing ? (
        <Card>
          <Button kind="secondary" label={h.scheduled} onPress={() => startForm('hours')} />
          <Button kind="secondary" label={h.lastMinute} onPress={() => startForm('lastMinute')} />
          <Button kind="link" label={h.cancel} onPress={() => setChoosing(false)} />
        </Card>
      ) : rules ? (
        <Button
          label={h.add}
          onPress={() => {
            setChoosing(true);
            setInfo('');
            setError('');
          }}
        />
      ) : null}

      {rules === null ? (
        !loadError ? (
          <Text style={styles.muted}>{t.loading}</Text>
        ) : null
      ) : rules.length === 0 ? (
        <Text style={styles.muted}>{h.empty}</Text>
      ) : (
        rules.map((rule) => (
          <Card key={rule.id}>
            <Text style={styles.discount}>{`−${rule.discountPercent}%`}</Text>
            <Text style={styles.name}>{summary(rule)}</Text>
            <Text style={styles.muted}>
              {`${h.staff}: ${namesText(rule.staffIds, staffNames, h.allStaff)}`}
            </Text>
            <Text style={styles.muted}>
              {`${h.services}: ${namesText(rule.serviceIds, serviceNames, h.allServices)}`}
            </Text>
            {removeId === rule.id ? (
              <View style={{ gap: 8 }}>
                <Text style={styles.text}>{h.removeAsk}</Text>
                <View style={styles.row}>
                  <Button
                    label={h.removeYes}
                    busy={busy}
                    onPress={() => {
                      setRemoveId(null);
                      void save(rulesToSave(rules, { remove: rule.id }), h.removed);
                    }}
                  />
                  <Button kind="secondary" label={h.removeNo} onPress={() => setRemoveId(null)} />
                </View>
              </View>
            ) : (
              <Button
                kind="link"
                label={h.remove}
                a11yLabel={fill(h.removeOne, { what: summary(rule) })}
                onPress={() => setRemoveId(rule.id)}
              />
            )}
          </Card>
        ))
      )}
    </ScrollView>
  );
}

function toggled<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
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
  name: { fontSize: 17, fontWeight: '600', color: colors.ink },
  discount: { fontSize: 22, fontWeight: '700', color: colors.accent },
  text: { fontSize: 15, color: colors.ink },
  label: { fontSize: 13, fontWeight: '700', color: colors.muted },
  muted: { color: colors.muted, fontSize: 15 },
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
