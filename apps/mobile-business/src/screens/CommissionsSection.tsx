import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Locale, SalonReport, StaffCommissions } from '../api';
import { parsePercent, percentInput, percentText } from '../commissions';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 375: "Prowizje" in the reports — what each specialist gets of what their paid visits
 * brought, by the percent the salon set (the same as in the cabinet, task 374). Owners and
 * managers also set the percents here; a specialist with own results sees only their own.
 */
export function CommissionsSection(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  report: SalonReport;
  money: (hundredths: number) => string;
  onSaved: () => void;
}) {
  const { api, t, locale, salon, report, money } = props;
  const r = t.reports;
  const canSet = report.scope === 'location';
  const rows = report.staff.filter((s) => s.commissionPercent !== null);
  const [list, setList] = useState<StaffCommissions['staff'] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  if (!canSet && rows.length === 0) return null;
  const total = rows.reduce((sum, row) => sum + (row.commissionGrosze ?? 0), 0);

  const show = (next: StaffCommissions) => {
    setList(next.staff);
    setDrafts(
      Object.fromEntries(
        next.staff.map((s) => [s.staffId, percentInput(s.commissionPercent, locale)]),
      ),
    );
  };

  const open = async () => {
    if (list) {
      setList(null);
      return;
    }
    setError('');
    try {
      show(await api.commissions(salon.orgId, salon.locationId));
    } catch (e) {
      setError(errorText(e, t));
    }
  };

  const save = async (staffId: string) => {
    const percent = parsePercent(drafts[staffId] ?? '');
    if (percent === undefined) {
      setError(r.commissionInvalid);
      return;
    }
    setBusy(staffId);
    setSaved('');
    setError('');
    try {
      show(await api.setCommission(salon.orgId, salon.locationId, staffId, percent));
      setSaved(staffId);
      props.onSaved();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy('');
    }
  };

  return (
    <View style={{ gap: 6 }} testID="report-commissions">
      <Text style={styles.section}>
        {rows.length > 0 ? fill(r.commissionsTotal, { amount: money(total) }) : r.commissions}
      </Text>
      {rows.map((row) => (
        <View key={row.id} style={styles.cardTop}>
          <Text style={styles.name}>{row.displayName}</Text>
          <Text style={styles.muted}>
            {fill(r.commissionRow, {
              percent: percentText(row.commissionPercent!, locale),
              amount: money(row.commissionGrosze ?? 0),
            })}
          </Text>
        </View>
      ))}
      <Text style={styles.small}>{r.commissionsHint}</Text>
      {canSet ? (
        <Button
          kind="secondary"
          label={list ? r.commissionsHide : r.commissionsSet}
          onPress={() => void open()}
        />
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {list ? (
        <View style={{ gap: 8 }} testID="commission-list">
          {list.map((s) => (
            <Card key={s.staffId}>
              <Text style={styles.name}>
                {s.displayName}
                {s.active ? '' : ` · ${r.commissionInactive}`}
              </Text>
              <View style={styles.row}>
                <TextInput
                  accessibilityLabel={fill(r.commissionLabel, { name: s.displayName })}
                  placeholder={r.commissionNone}
                  placeholderTextColor={colors.placeholder}
                  keyboardType="decimal-pad"
                  value={drafts[s.staffId] ?? ''}
                  onChangeText={(text) => {
                    setSaved('');
                    setDrafts({ ...drafts, [s.staffId]: text });
                  }}
                  maxLength={5}
                  style={styles.input}
                />
                <Text style={styles.muted}>%</Text>
                <Button
                  label={r.commissionSave}
                  a11yLabel={fill(r.commissionSaveFor, { name: s.displayName })}
                  busy={busy === s.staffId}
                  disabled={busy !== '' && busy !== s.staffId}
                  onPress={() => void save(s.staffId)}
                />
              </View>
              {saved === s.staffId ? (
                <Text role="status" style={styles.small}>
                  {r.commissionSaved}
                </Text>
              ) : null}
            </Card>
          ))}
          <Text style={styles.small}>{r.commissionsSetHint}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 8, fontSize: 13, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  name: { fontSize: 16, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink,
    width: 90,
  },
});
