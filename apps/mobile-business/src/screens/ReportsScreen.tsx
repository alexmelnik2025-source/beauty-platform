import { useCallback, useEffect, useState } from 'react';
import { BackHandler, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, Locale, SalonReport } from '../api';
import { dayTitle, formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  change,
  onlineShare,
  REPORT_PERIODS,
  reportRange,
  starsText,
  weekdayLong,
  type ReportPeriod,
} from '../reports';
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

  const previous = shown?.previous;
  /** Task 141: minutes as hours, "12,5". */
  const hours = (minutes: number) =>
    new Intl.NumberFormat(props.locale, { maximumFractionDigits: 1 }).format(minutes / 60);
  const ratings = shown?.ratings;
  const maxStars = Math.max(1, ...(ratings?.stars ?? [1]));
  const maxWeekday = Math.max(1, ...(shown?.weekdays.map((d) => d.completed) ?? [1]));
  const stat = (label: string, value: string, sub?: string, trend?: string | null) => (
    <View style={styles.stat} key={label}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.value}>
        {value}
        {trend ? (
          <Text style={[styles.trend, trend.startsWith('+') && styles.trendUp]}> {trend}</Text>
        ) : null}
      </Text>
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
              previous && change(totals.revenueGrosze, previous.revenueGrosze),
            )}
            {stat(
              r.average,
              money(totals.averageTicketGrosze),
              undefined,
              previous && change(totals.averageTicketGrosze, previous.averageTicketGrosze),
            )}
            {stat(
              r.completed,
              String(totals.completed),
              fill(r.upcoming, { n: String(totals.upcoming) }),
              previous && change(totals.completed, previous.completed),
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
              previous && change(totals.clients, previous.clients),
            )}
            {stat(
              r.online,
              String(totals.online),
              fill(r.onlineShare, { n: String(onlineShare(totals)) }),
            )}
          </View>
          {previous ? (
            <Text style={styles.small}>
              {fill(r.compared, {
                from: dayTitle(previous.from, props.locale),
                to: dayTitle(previous.to, props.locale),
              })}
            </Text>
          ) : null}
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
          {totals.visits > 0 ? (
            <View style={{ gap: 6 }}>
              <Text style={styles.section}>{r.byWeekday}</Text>
              {shown.weekdays.map((d) => (
                <View key={d.weekday} style={styles.weekday}>
                  <Text style={styles.weekdayName}>{weekdayLong(d.weekday, props.locale)}</Text>
                  <View style={styles.bar}>
                    <View
                      style={[styles.barFill, { width: `${(d.completed / maxWeekday) * 100}%` }]}
                    />
                  </View>
                  <Text style={styles.small}>
                    {fill(r.weekdayVisits, { n: String(d.completed) })}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          {shown.occupancy.staff.length > 0 ? (
            <View style={{ gap: 6 }} testID="report-occupancy">
              <Text style={styles.section}>
                {fill(r.occupancy, { n: String(shown.occupancy.percent) })}
              </Text>
              {shown.occupancy.staff.map((s) => (
                <View key={s.id} style={{ gap: 2 }}>
                  <View style={styles.weekday}>
                    <Text style={styles.weekdayName} numberOfLines={1}>
                      {s.displayName}
                    </Text>
                    <View
                      style={styles.bar}
                      accessibilityRole="progressbar"
                      accessibilityLabel={s.displayName}
                      accessibilityValue={{ min: 0, max: 100, now: s.percent }}
                    >
                      <View style={[styles.barFill, { width: `${Math.min(100, s.percent)}%` }]} />
                    </View>
                    <Text style={styles.small}>{s.percent}%</Text>
                  </View>
                  <Text style={styles.small}>
                    {fill(r.occupancyHours, {
                      booked: hours(s.bookedMinutes),
                      work: hours(s.workMinutes),
                    })}
                  </Text>
                </View>
              ))}
              <Text style={styles.small}>{r.occupancyHint}</Text>
            </View>
          ) : null}
          {ratings && ratings.average !== null ? (
            <View style={{ gap: 6 }} testID="report-ratings">
              <Text style={styles.section}>
                {fill(r.ratings, { stars: starsText(ratings.average, props.locale) })}
              </Text>
              <Text style={styles.small}>
                {fill(r.ratingsCount, { n: String(ratings.reviews) })}
              </Text>
              {[5, 4, 3, 2, 1].map((n) => {
                const count = ratings.stars[n - 1] ?? 0;
                return (
                  <View key={n} style={styles.weekday}>
                    <Text style={styles.weekdayName}>{'★'.repeat(n)}</Text>
                    <View
                      style={styles.bar}
                      accessibilityRole="progressbar"
                      accessibilityLabel={`${n} ★`}
                      accessibilityValue={{ min: 0, max: ratings.reviews, now: count }}
                    >
                      <View style={[styles.barFill, { width: `${(count / maxStars) * 100}%` }]} />
                    </View>
                    <Text style={styles.small}>{count}</Text>
                  </View>
                );
              })}
              {shown?.scope !== 'own'
                ? ratings.staff.map((s) => (
                    <View key={s.id} style={styles.weekday}>
                      <Text style={[styles.weekdayName, { flexGrow: 1 }]} numberOfLines={1}>
                        {s.displayName}
                      </Text>
                      <Text style={styles.small}>
                        {fill(r.ratingsStaff, {
                          stars: starsText(s.average, props.locale),
                          n: String(s.reviews),
                        })}
                      </Text>
                    </View>
                  ))
                : null}
              <Text style={styles.small}>{r.ratingsHint}</Text>
            </View>
          ) : null}
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
  salon: { color: colors.accent, fontWeight: '700', fontSize: 15, flexShrink: 1 },
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
  trend: { fontSize: 13, fontWeight: '600', color: colors.danger },
  trendUp: { color: colors.ink },
  weekday: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  weekdayName: { width: 110, color: colors.ink, fontSize: 14 },
  bar: { flex: 1, height: 8, backgroundColor: colors.line, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: colors.ink },
});
