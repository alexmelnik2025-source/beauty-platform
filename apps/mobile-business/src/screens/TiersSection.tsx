import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Locale, LoyaltyTiers } from '../api';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { MAX_TIERS, tierRows, tiersToSave, type TierRow } from '../tiers';
import { Button, Card, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 345: "Poziomy klientów" in "Program lojalnościowy" (owners and managers): the tiers with
 * their thresholds and discounts, and "Zmień poziomy" — counted from visits or the amount paid,
 * over how many days, and up to 8 rows (name, from, discount). Saved as a whole list.
 */
export function TiersSection(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
}) {
  const { api, t, salon } = props;
  const l = t.loyalty;
  const [data, setData] = useState<LoyaltyTiers | null>(null);
  const [form, setForm] = useState<{
    basis: LoyaltyTiers['basis'];
    period: string;
    rows: TierRow[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    api.loyaltyTiers(salon.orgId).then(
      (d) => alive && setData(d),
      (e: unknown) => alive && setNote({ text: errorText(e, t), bad: true }),
    );
    return () => {
      alive = false;
    };
  }, [api, salon, t]);

  if (!data) return note ? <ErrorText>{note.text}</ErrorText> : null;
  const money = (grosze: number) => formatPrice(grosze, salon.currency, props.locale);

  async function save() {
    if (!form) return;
    const checked = tiersToSave(form.basis, form.period, form.rows);
    if (!checked.ok) {
      return setNote({
        text: fill(l.tiersProblem[checked.problem], { n: String((checked.row ?? 0) + 1) }),
        bad: true,
      });
    }
    setBusy(true);
    setNote(null);
    try {
      setData(await api.saveLoyaltyTiers(salon.orgId, checked.save));
      setForm(null);
      setNote({ text: l.tiersSaved, bad: false });
    } catch (e) {
      setNote({ text: errorText(e, t), bad: true });
    } finally {
      setBusy(false);
    }
  }

  const setRow = (index: number, change: Partial<TierRow>) =>
    form &&
    setForm({ ...form, rows: form.rows.map((r, i) => (i === index ? { ...r, ...change } : r)) });

  const message = note ? (
    note.bad ? (
      <ErrorText>{note.text}</ErrorText>
    ) : (
      <Text role="status" style={styles.info}>
        {note.text}
      </Text>
    )
  ) : null;

  if (!form) {
    return (
      <Card>
        <Text style={styles.muted}>{l.tiersHint}</Text>
        {data.tiers.length === 0 ? (
          <Text style={styles.text}>{l.tiersNone}</Text>
        ) : (
          <>
            {data.tiers.map((tier) => (
              <Text key={tier.id} style={styles.text}>
                {tier.name} ·{' '}
                {data.basis === 'spend'
                  ? fill(l.tierFromSpend, { amount: money(tier.threshold) })
                  : fill(l.tierFromVisits, { count: String(tier.threshold) })}
                {tier.discountPercent > 0 ? ` · −${tier.discountPercent}%` : ''}
              </Text>
            ))}
            <Text style={styles.muted}>
              {fill(l.tierPeriodLine, { days: String(data.periodDays) })}
            </Text>
          </>
        )}
        {message}
        <Button
          kind="secondary"
          label={l.tiersChange}
          onPress={() => {
            setNote(null);
            setForm({ basis: data.basis, period: String(data.periodDays), rows: tierRows(data) });
          }}
        />
      </Card>
    );
  }

  return (
    <Card>
      <View style={styles.row}>
        <Chip
          label={l.tierBasisVisits}
          on={form.basis === 'visits'}
          onPress={() => setForm({ ...form, basis: 'visits' })}
        />
        <Chip
          label={l.tierBasisSpend}
          on={form.basis === 'spend'}
          onPress={() => setForm({ ...form, basis: 'spend' })}
        />
      </View>
      <Text style={styles.label}>{l.tierPeriod}</Text>
      <TextInput
        accessibilityLabel={l.tierPeriod}
        value={form.period}
        onChangeText={(period) => setForm({ ...form, period })}
        keyboardType="number-pad"
        style={styles.input}
      />
      {form.rows.map((row, i) => {
        const n = { n: String(i + 1) };
        return (
          <View key={i} style={styles.tier}>
            <TextInput
              accessibilityLabel={fill(l.tierName, n)}
              placeholder={fill(l.tierName, n)}
              placeholderTextColor={colors.placeholder}
              value={row.name}
              maxLength={40}
              onChangeText={(name) => setRow(i, { name })}
              style={styles.input}
            />
            <View style={styles.row}>
              <TextInput
                accessibilityLabel={
                  form.basis === 'spend'
                    ? fill(l.tierThresholdSpend, { ...n, currency: salon.currency })
                    : fill(l.tierThresholdVisits, n)
                }
                placeholder={
                  form.basis === 'spend'
                    ? fill(l.tierThresholdSpend, { ...n, currency: salon.currency })
                    : fill(l.tierThresholdVisits, n)
                }
                placeholderTextColor={colors.placeholder}
                value={row.threshold}
                keyboardType={form.basis === 'spend' ? 'decimal-pad' : 'number-pad'}
                onChangeText={(threshold) => setRow(i, { threshold })}
                style={[styles.input, styles.grow]}
              />
              <TextInput
                accessibilityLabel={fill(l.tierDiscount, n)}
                placeholder={fill(l.tierDiscount, n)}
                placeholderTextColor={colors.placeholder}
                value={row.discountPercent}
                keyboardType="number-pad"
                onChangeText={(discountPercent) => setRow(i, { discountPercent })}
                style={[styles.input, styles.grow]}
              />
            </View>
            <View style={styles.row}>
              <Button
                kind="link"
                label={fill(l.tierRemove, n)}
                onPress={() => setForm({ ...form, rows: form.rows.filter((_, j) => j !== i) })}
              />
            </View>
          </View>
        );
      })}
      {form.rows.length < MAX_TIERS ? (
        <Button
          kind="secondary"
          label={l.tierAdd}
          onPress={() =>
            setForm({
              ...form,
              rows: [...form.rows, { name: '', threshold: '', discountPercent: '0' }],
            })
          }
        />
      ) : null}
      {message}
      <View style={styles.row}>
        <Button label={l.tiersSave} busy={busy} onPress={() => void save()} />
        <Button
          kind="secondary"
          label={l.cancel}
          onPress={() => {
            setForm(null);
            setNote(null);
          }}
        />
      </View>
    </Card>
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
  tier: { gap: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.line },
  grow: { flex: 1, minWidth: 120 },
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
