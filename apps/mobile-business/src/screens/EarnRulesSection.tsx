import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, LoyaltyProgram } from '../api';
import {
  earnRows,
  earnServices,
  earnSummary,
  earnToSave,
  type EarnRows,
  type EarnService,
} from '../earnRules';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 347: "Pieczątki i punkty za usługi" in "Program lojalnościowy" (owners and managers): the
 * services with their own number in short ("Broda · 2") and "Zmień" — a field per service of this
 * salon (empty = the general rule, 0 = nothing). Saved as the whole list of this salon.
 */
export function EarnRulesSection(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  program: LoyaltyProgram;
  /** Active services of this salon. */
  services: EarnService[];
  onSaved: (program: LoyaltyProgram) => void;
}) {
  const { api, t, salon, program } = props;
  const l = t.loyalty;
  const [rows, setRows] = useState<EarnRows | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  const services = earnServices(program, salon.locationId, props.services);
  const unit = program.mode === 'stamps' ? l.earnStamps : l.earnPoints;

  async function save() {
    if (!rows) return;
    const checked = earnToSave(rows, services);
    if (!checked.ok) {
      return setNote({ text: fill(l.earnProblem, { service: checked.service }), bad: true });
    }
    setBusy(true);
    setNote(null);
    try {
      props.onSaved(await api.saveLoyaltyEarnRules(salon.orgId, salon.locationId, checked.save));
      setRows(null);
      setNote({ text: l.earnSaved, bad: false });
    } catch (e) {
      setNote({ text: errorText(e, t), bad: true });
    } finally {
      setBusy(false);
    }
  }

  const message = note ? (
    note.bad ? (
      <ErrorText>{note.text}</ErrorText>
    ) : (
      <Text role="status" style={styles.info}>
        {note.text}
      </Text>
    )
  ) : null;

  if (services.length === 0) {
    return (
      <Card>
        <Text style={styles.muted}>{l.noServices}</Text>
      </Card>
    );
  }

  if (!rows) {
    const own = earnSummary(program, salon.locationId, services);
    return (
      <Card>
        <Text style={styles.muted}>{l.earnHint}</Text>
        {own.length === 0 ? (
          <Text style={styles.text}>{l.earnNone}</Text>
        ) : (
          own.map((s) => (
            <Text key={s.name} style={styles.text}>
              {fill(l.earnLine, { service: s.name, count: String(s.points), unit })}
            </Text>
          ))
        )}
        {message}
        <Button
          kind="secondary"
          label={l.earnChange}
          onPress={() => {
            setNote(null);
            setRows(earnRows(program, salon.locationId));
          }}
        />
      </Card>
    );
  }

  return (
    <Card>
      <Text style={styles.muted}>{l.earnHint}</Text>
      {services.map((s) => (
        <View key={s.id} style={styles.item}>
          <Text style={styles.text}>{s.name}</Text>
          <TextInput
            accessibilityLabel={fill(l.earnField, { service: s.name, unit })}
            placeholder={l.earnGeneral}
            placeholderTextColor={colors.placeholder}
            value={rows[s.id] ?? ''}
            onChangeText={(value) => setRows({ ...rows, [s.id]: value })}
            keyboardType="number-pad"
            style={styles.input}
          />
        </View>
      ))}
      {message}
      <View style={styles.row}>
        <Button label={l.earnSave} busy={busy} onPress={() => void save()} />
        <Button
          kind="secondary"
          label={l.cancel}
          onPress={() => {
            setNote(null);
            setRows(null);
          }}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  item: { gap: 6, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line },
  text: { fontSize: 15, color: colors.ink },
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
});
