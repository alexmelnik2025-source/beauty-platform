import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
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
import { Button, Card, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

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
  const [rows, setRows] = useState<BonusRow[] | null>(null);
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
  }, [api, salon, t]);

  if (!data) return note ? <ErrorText>{note.text}</ErrorText> : null;

  async function save() {
    if (!rows) return;
    const checked = bonusToSave(rows);
    if (!checked.ok) {
      return setNote({
        text: fill(l.bonusProblem[checked.problem], { n: String((checked.row ?? 0) + 1) }),
        bad: true,
      });
    }
    setBusy(true);
    setNote(null);
    try {
      setData(await api.saveLoyaltyBonusRules(salon.orgId, checked.save));
      setRows(null);
      setNote({ text: l.bonusSaved, bad: false });
    } catch (e) {
      setNote({ text: errorText(e, t), bad: true });
    } finally {
      setBusy(false);
    }
  }

  const setRow = (index: number, change: Partial<BonusRow>) =>
    rows && setRows(rows.map((r, i) => (i === index ? { ...r, ...change } : r)));

  const message = note ? (
    note.bad ? (
      <ErrorText>{note.text}</ErrorText>
    ) : (
      <Text role="status" style={styles.info}>
        {note.text}
      </Text>
    )
  ) : null;

  if (!rows) {
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
            setRows(bonusRows(data));
          }}
        />
      </Card>
    );
  }

  return (
    <Card>
      {rows.map((row, i) => {
        const n = { n: String(i + 1) };
        return (
          <View key={i} style={styles.item}>
            <TextInput
              accessibilityLabel={fill(l.bonusName, n)}
              placeholder={fill(l.bonusName, n)}
              placeholderTextColor={colors.placeholder}
              value={row.name}
              maxLength={60}
              onChangeText={(name) => setRow(i, { name })}
              style={styles.input}
            />
            <View style={styles.row}>
              <Labeled
                label={fill(l.bonusMultiplier, n)}
                value={row.multiplier}
                onChange={(multiplier) => setRow(i, { multiplier })}
              />
              <Labeled
                label={fill(l.bonusExtra, n)}
                value={row.extraPoints}
                onChange={(extraPoints) => setRow(i, { extraPoints })}
              />
            </View>
            <Text style={styles.label}>{l.bonusDays}</Text>
            <View style={styles.row}>
              {WEEKDAYS.map((d) => (
                <Chip
                  key={d}
                  label={shortWeekday(d, locale)}
                  on={row.weekdays.includes(d)}
                  onPress={() => setRow(i, { weekdays: toggled(row.weekdays, d) })}
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
                      onPress={() => setRow(i, { staffIds: toggled(row.staffIds, s.id) })}
                    />
                  ))}
                </View>
              </>
            ) : null}
            <Labeled
              label={fill(l.bonusWithin, n)}
              value={row.withinDays}
              onChange={(withinDays) => setRow(i, { withinDays })}
            />
            <View style={styles.row}>
              <Button
                kind="link"
                label={fill(l.bonusRemove, n)}
                onPress={() => setRows(rows.filter((_, j) => j !== i))}
              />
            </View>
          </View>
        );
      })}
      {rows.length < MAX_BONUS_RULES ? (
        <Button
          kind="secondary"
          label={l.bonusAdd}
          onPress={() => setRows([...rows, { ...EMPTY_BONUS }])}
        />
      ) : null}
      {message}
      <View style={styles.row}>
        <Button label={l.bonusSave} busy={busy} onPress={() => void save()} />
        <Button
          kind="secondary"
          label={l.cancel}
          onPress={() => {
            setRows(null);
            setNote(null);
          }}
        />
      </View>
    </Card>
  );
}

function Labeled(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <View style={styles.labeled}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
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
