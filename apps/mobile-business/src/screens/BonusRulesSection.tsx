import { FieldError, FormField } from '../formFields';
import { useFormDraft } from '../formDrafts';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, Locale, LoyaltyBonusRules } from '../api';
import {
  bonusGives,
  bonusRows,
  bonusToSave,
  EMPTY_BONUS,
  MAX_BONUS_RULES,
  toggled,
  type BonusRow,
} from '../bonusRules';
import { errorText } from '../errors';
import { daysText, shortWeekday } from '../happyHours';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Pressable } from '../ui';
import type { SalonChoice } from './SalonsScreen';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/** A null entry removes a row. Other entries hold only fields the user changed. */
export type RuleRowChanges<Row> = Record<string, Partial<Row> | null>;

export function editableRuleRows<Row extends object>(
  saved: { id: string }[],
  values: Row[],
  empty: Row,
  changes: RuleRowChanges<Row>,
  onChange: (next: RuleRowChanges<Row>) => void,
) {
  const all = values.map((value, index) => ({ key: `saved:${saved[index]!.id}`, value }));
  for (const key of Object.keys(changes)) {
    if (key.startsWith('new:')) all.push({ key, value: empty });
  }
  const rows = all
    .filter(({ key }) => changes[key] !== null)
    .map(({ key, value }) => ({ key, value: { ...value, ...changes[key] } }));

  return {
    rows,
    change: (key: string, fields: Partial<Row>) =>
      onChange({ ...changes, [key]: { ...changes[key], ...fields } }),
    remove: (key: string) => onChange({ ...changes, [key]: null }),
    add: () => onChange({ ...changes, [`new:${Object.keys(changes).length}`]: {} }),
  };
}

/**
 * Task 346: "Dodatkowe pieczątki i punkty" in "Program lojalnościowy" (owners and managers): the
 * rules in short ("×2 · pon., wt. · Kasia") and "Zmień zasady dodatkowe" — name, specialists,
 * days, ×N, +N and "when back within N days". Saved as a whole list.
 */
export function BonusRulesSection(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
}) {
  const { api, t, salon, locale } = props;
  const l = t.loyalty;
  const [data, setData] = useState<LoyaltyBonusRules | null>(null);
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([]);
  const [draft, setDraft] = useFormDraft<{
    session: symbol;
    rows: RuleRowChanges<BonusRow>;
  } | null>('loyaltyBonus.rows', null);
  const [invalid, setInvalid] = useState<Extract<
    ReturnType<typeof bonusToSave>,
    { ok: false }
  > | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.loyaltyBonusRules(salon.orgId),
      api.staff(salon.orgId, salon.locationId),
    ]).then(
      ([rules, team]) => {
        if (!alive) return;
        setData(rules);
        // This salon's specialists, plus any of another salon already named in a rule.
        const known = new Map(team.filter((s) => s.active).map((s) => [s.id, s.displayName]));
        for (const rule of rules.rules) {
          for (const s of rule.staff) if (!known.has(s.id)) known.set(s.id, s.displayName);
        }
        setStaff([...known].map(([id, name]) => ({ id, name })));
      },
      (e: unknown) => alive && setNote({ text: errorText(e, t), bad: true }),
    );
    return () => {
      alive = false;
    };
  }, [api, salon, t, loadAttempt]);

  if (!data) {
    return note ? (
      <Card>
        <ErrorText>{note.text}</ErrorText>
        <Button
          kind="secondary"
          label={t.day.refresh}
          onPress={() => {
            setNote(null);
            setLoadAttempt((attempt) => attempt + 1);
          }}
        />
      </Card>
    ) : null;
  }

  const errorAt = (problem: NonNullable<typeof invalid>['problem'], row?: number) =>
    invalid?.problem === problem && invalid.row === row
      ? fill(l.bonusProblem[problem], { n: String((row ?? 0) + 1) })
      : undefined;

  const message = note ? (
    note.bad ? (
      <ErrorText>{note.text}</ErrorText>
    ) : (
      <Text role="status" style={styles.info}>
        {note.text}
      </Text>
    )
  ) : null;

  if (!draft) {
    return (
      <Card>
        <Text style={styles.muted}>{l.bonusRulesHint}</Text>
        {data.rules.length === 0 ? (
          <Text style={styles.text}>{l.bonusNone}</Text>
        ) : (
          data.rules.map((rule) => (
            <View key={rule.id} style={styles.item}>
              <Text style={styles.text}>
                {rule.name} · {bonusGives(rule)}
              </Text>
              <Text style={styles.muted}>
                {[
                  rule.weekdays.length === 0
                    ? l.bonusEveryDay
                    : daysText(rule.weekdays, locale, l.bonusEveryDay),
                  rule.staff.length === 0
                    ? l.bonusEveryone
                    : rule.staff.map((s) => s.displayName).join(', '),
                  rule.withinDays !== null
                    ? fill(l.bonusWithinLine, { days: String(rule.withinDays) })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
          ))
        )}
        {message}
        <Button
          kind="secondary"
          label={l.bonusChange}
          onPress={() => {
            setNote(null);
            setDraft({ session: Symbol(), rows: {} });
          }}
        />
      </Card>
    );
  }

  const editor = editableRuleRows(data.rules, bonusRows(data), EMPTY_BONUS, draft.rows, (rows) =>
    setDraft({ ...draft, rows }),
  );

  const { session } = draft;

  async function save() {
    const checked = bonusToSave(editor.rows.map(({ value }) => value));
    setInvalid(null);
    if (!checked.ok) return setInvalid(checked);
    setBusy(true);
    try {
      setData(await api.saveLoyaltyBonusRules(salon.orgId, checked.save));
      setDraft((current) => (current?.session === session ? null : current));
      setNote({ text: l.bonusSaved, bad: false });
    } catch (e) {
      setNote({ text: errorText(e, t), bad: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      {editor.rows.map(({ key, value: row }, i) => {
        const n = { n: String(i + 1) };
        return (
          <View key={key} style={styles.item}>
            <FormField
              error={errorAt('name', i)}
              accessibilityLabel={fill(l.bonusName, n)}
              placeholder={fill(l.bonusName, n)}
              placeholderTextColor={colors.placeholder}
              value={row.name}
              maxLength={60}
              onChangeText={(name) => editor.change(key, { name })}
              style={styles.input}
            />
            <View style={styles.row}>
              <Labeled
                error={errorAt('multiplier', i) || errorAt('nothing', i)}
                label={fill(l.bonusMultiplier, n)}
                value={row.multiplier}
                onChange={(multiplier) => editor.change(key, { multiplier })}
              />
              <Labeled
                error={errorAt('extra', i)}
                label={fill(l.bonusExtra, n)}
                value={row.extraPoints}
                onChange={(extraPoints) => editor.change(key, { extraPoints })}
              />
            </View>
            <Text style={styles.label}>{l.bonusDays}</Text>
            <View style={styles.row}>
              {WEEKDAYS.map((d) => (
                <Chip
                  key={d}
                  label={shortWeekday(d, locale)}
                  on={row.weekdays.includes(d)}
                  onPress={() => editor.change(key, { weekdays: toggled(row.weekdays, d) })}
                />
              ))}
            </View>
            {staff.length > 0 ? (
              <>
                <Text style={styles.label}>{l.bonusStaff}</Text>
                <View style={styles.row}>
                  {staff.map((s) => (
                    <Chip
                      key={s.id}
                      label={s.name}
                      on={row.staffIds.includes(s.id)}
                      onPress={() => editor.change(key, { staffIds: toggled(row.staffIds, s.id) })}
                    />
                  ))}
                </View>
              </>
            ) : null}
            <Labeled
              error={errorAt('within', i)}
              label={fill(l.bonusWithin, n)}
              value={row.withinDays}
              onChange={(withinDays) => editor.change(key, { withinDays })}
            />
            <View style={styles.row}>
              <Button
                kind="link"
                label={fill(l.bonusRemove, n)}
                onPress={() => editor.remove(key)}
              />
            </View>
          </View>
        );
      })}
      {editor.rows.length < MAX_BONUS_RULES ? (
        <Button kind="secondary" label={l.bonusAdd} onPress={editor.add} />
      ) : null}
      <FieldError message={errorAt('tooMany')} />
      {message}
      <View style={styles.row}>
        <Button label={l.bonusSave} busy={busy} onPress={save} />
        <Button
          kind="secondary"
          label={l.cancel}
          onPress={() => {
            setDraft(null);
            setInvalid(null);
            setNote(null);
          }}
        />
      </View>
    </Card>
  );
}

function Labeled(props: {
  label: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.labeled}>
      <Text style={styles.label}>{props.label}</Text>
      <FormField
        error={props.error}
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        keyboardType="number-pad"
        style={styles.input}
      />
    </View>
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
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  item: { gap: 6, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line },
  labeled: { gap: 4, flex: 1, minWidth: 130 },
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
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 15, color: colors.ink },
});
