import { useCallback, useEffect, useState } from 'react';
import { BackHandler, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, Locale, SalonReport } from '../api';
import { dayTitle, formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { onlineShare, REPORT_PERIODS, reportRange, type ReportPeriod } from '../reports';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * "Raporty" (task 15): revenue, visits, clients, specialists and services for a period — the
 * same report as in the cabinet. A specialist gets only their own visits (the server decides).
 */
export function ReportsScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  today: string;
  onBack: () => void;
}) {
  const { api, t, salon, today, onBack } = props;
  const r = t.reports;
  const [period, setPeriod] = useState<ReportPeriod>('thisMonth');
  const [report, setReport] = useState<SalonReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const range = reportRange(period, today);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await api.report(salon.orgId, salon.locationId, range.from, range.to));
      setError('');
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setLoading(false);
    }
  }, [api, salon, range.from, range.to, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Android "back" closes the reports instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const money = (hundredths: number) =>
    formatPrice(hundredths, report?.location.currency ?? salon.currency, props.locale);
  const shown = report && report.from === range.from && report.to === range.to ? report : null;
  const totals = shown?.totals;

  const stat = (label: string, value: string, sub?: string) => (
    <View style={styles.stat} key={label}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
      {sub ? <Text style={styles.small}>{sub}</Text> : null}
    </View>
  );

  return (
    <ScrollView
      contentContainerStyle={styles.screen}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
    >
      <View style={styles.top}>
        <Button kind="link" label={r.back} onPress={onBack} />
        <Text style={styles.salon}>{salon.locationName}</Text>
      </View>
      <Heading>{r.title}</Heading>
      <View style={styles.row}>
        {REPORT_PERIODS.map((p) => (
          <Button
            key={p}
            kind={p === period ? 'primary' : 'secondary'}
            label={r[p]}
            onPress={() => setPeriod(p)}
          />
        ))}
      </View>
      <Text style={styles.muted}>
        {dayTitle(range.from, props.locale)} – {dayTitle(range.to, props.locale)}
      </Text>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {shown?.scope === 'own' ? <Text style={styles.muted}>{r.ownHint}</Text> : null}

      {shown && totals ? (
        <>
          <View style={styles.stats}>
            {stat(
              r.revenue,
              money(totals.revenueGrosze),
              fill(r.paidCount, { n: String(totals.paid) }),
            )}
            {stat(r.average, money(totals.averageTicketGrosze))}
            {stat(
              r.completed,
              String(totals.completed),
              fill(r.upcoming, { n: String(totals.upcoming) }),
            )}
            {stat(r.noShow, String(totals.noShow))}
            {stat(
              r.cancelled,
              String(totals.cancelledByClient + totals.cancelledBySalon),
              fill(r.cancelledSplit, {
                client: String(totals.cancelledByClient),
                salon: String(totals.cancelledBySalon),
              }),
            )}
            {stat(
              r.clients,
              String(totals.clients),
              fill(r.newClients, { n: String(totals.newClients) }),
            )}
            {stat(
              r.online,
              String(totals.online),
              fill(r.onlineShare, { n: String(onlineShare(totals)) }),
            )}
          </View>
          <Text style={styles.small}>{r.note}</Text>

          {totals.visits === 0 ? (
            <Text style={styles.muted}>{r.empty}</Text>
          ) : (
            (
              [
                [r.byStaff, shown.staff.map((s) => ({ ...s, name: s.displayName }))],
                [r.byService, shown.services],
              ] as const
            ).map(([title, rows]) => (
              <View key={title} style={{ gap: 8 }}>
                <Text style={styles.section}>{title}</Text>
                {rows.map((row) => (
                  <Card key={row.id}>
                    <View style={styles.cardTop}>
                      <Text style={styles.name}>{row.name}</Text>
                      <Text style={styles.name}>{money(row.revenueGrosze)}</Text>
                    </View>
                    <Text style={styles.muted}>
                      {fill(r.row, {
                        completed: String(row.completed),
                        noShow: String(row.noShow),
                      })}
                    </Text>
                  </Card>
                ))}
              </View>
            ))
          )}
        </>
      ) : !error ? (
        <Text style={styles.muted}>{t.loading}</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  salon: { color: colors.gold, fontWeight: '700', fontSize: 15, flexShrink: 1 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: {
    flexGrow: 1,
    flexBasis: '45%',
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 2,
  },
  value: { fontSize: 22, fontWeight: '700', color: colors.ink },
  section: { marginTop: 8, fontSize: 13, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  name: { fontSize: 16, fontWeight: '600', color: colors.ink, flexShrink: 1 },
});
