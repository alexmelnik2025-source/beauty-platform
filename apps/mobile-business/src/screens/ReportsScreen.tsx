import { useCallback, useEffect, useState } from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { BusinessApi, Locale, SalonReport } from '../api';
import { dayTitle, formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  change,
  onlineShare,
  peakHours,
  REPORT_PERIODS,
  reportRange,
  starsText,
  weekdayLong,
  type ReportPeriod,
} from '../reports';
import { shareCsv, type CsvShareTools } from '../share';
import { signed } from '../tillClose';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import { ClientScreen } from './ClientScreen';
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
  /** Task 217: a top client's card opens with the salon's time zone. */
  timeZone: string;
  onBack: () => void;
}) {
  const { api, t, salon, today, onBack } = props;
  const r = t.reports;
  const [period, setPeriod] = useState<ReportPeriod>('thisMonth');
  const [report, setReport] = useState<SalonReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [clientId, setClientId] = useState<string | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvInfo, setCsvInfo] = useState('');
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

  // Task 220: the accountant's CSV of the period — saved in a browser, shared on a phone.
  // Task 238: "till" — the till's cash journal (owners and managers).
  const downloadCsv = async (kind: 'visits' | 'till' = 'visits') => {
    if (csvBusy) return;
    setCsvBusy(true);
    setCsvInfo('');
    try {
      const file = await (kind === 'till' ? api.tillCsv : api.visitsCsv).call(
        api,
        salon.orgId,
        salon.locationId,
        range.from,
        range.to,
        props.locale,
      );
      const result = await shareCsv(file, csvTools());
      setCsvInfo(result === 'failed' ? r.csvFailed : '');
    } catch (e) {
      setCsvInfo(errorText(e, t));
    } finally {
      setCsvBusy(false);
    }
  };

  // Android "back" closes the reports instead of the app (a client card handles it itself).
  useEffect(() => {
    if (clientId) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack, clientId]);

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

  if (clientId) {
    return (
      <ClientScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        id={clientId}
        timeZone={props.timeZone}
        onBack={() => setClientId(null)}
      />
    );
  }

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
          {totals.visits > 0 ? (
            <View style={{ gap: 4 }}>
              <Button
                kind="secondary"
                label={csvBusy ? t.loading : r.csv}
                onPress={() => void downloadCsv()}
              />
              <Text style={styles.small}>{Platform.OS === 'web' ? r.csvHint : r.csvHintPhone}</Text>
              {csvInfo ? (
                <Text role="status" style={styles.small}>
                  {csvInfo}
                </Text>
              ) : null}
            </View>
          ) : null}

          {shown.scope === 'location' ? (
            <View style={{ gap: 4 }}>
              <Button
                kind="secondary"
                label={csvBusy ? t.loading : r.tillCsv}
                onPress={() => void downloadCsv('till')}
              />
              <Text style={styles.small}>{r.tillCsvHint}</Text>
            </View>
          ) : null}

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
                    {row.cancelledByClient + row.cancelledBySalon > 0 ? (
                      <Text style={styles.muted}>
                        {fill(r.rowCancelled, {
                          n: String(row.cancelledByClient + row.cancelledBySalon),
                          split: fill(r.cancelledSplit, {
                            client: String(row.cancelledByClient),
                            salon: String(row.cancelledBySalon),
                          }),
                        })}
                      </Text>
                    ) : null}
                  </Card>
                ))}
              </View>
            ))
          )}
          {shown.payments.length > 0 ? (
            <View style={{ gap: 6 }} testID="report-payments">
              <Text style={styles.section}>{r.payments}</Text>
              {shown.payments.map((p) => (
                <View key={p.method} style={styles.cardTop}>
                  <Text style={styles.name}>
                    {p.method === 'unknown' ? r.paymentsUnknown : t.visit.paymentMethods[p.method]}
                  </Text>
                  <Text style={styles.muted}>
                    {fill(r.paymentsRow, { amount: money(p.revenueGrosze), n: String(p.paid) })}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          {shown.tips.totalGrosze > 0 ? (
            <View style={{ gap: 6 }} testID="report-tips">
              <Text style={styles.section}>
                {fill(r.tips, { amount: money(shown.tips.totalGrosze) })}
              </Text>
              {shown.tips.staff.map((row) => (
                <View key={row.id} style={styles.cardTop}>
                  <Text style={styles.name}>{row.displayName}</Text>
                  <Text style={styles.muted}>
                    {fill(r.tipsRow, { amount: money(row.tipsGrosze), n: String(row.visits) })}
                  </Text>
                </View>
              ))}
              <Text style={styles.muted}>{r.tipsHint}</Text>
            </View>
          ) : null}
          {shown.tillCloses.days.length > 0 ? (
            // Task 235: the days of the period whose till was counted ("Zamknij kasę", task 232).
            <View style={{ gap: 6 }} testID="report-till-closes">
              <Text style={styles.section}>
                {fill(r.tillCloses, { sum: signed(shown.tillCloses.differenceGrosze, money) })}
              </Text>
              {shown.tillCloses.days.map((d) => (
                <View key={d.date} style={styles.cardTop}>
                  <Text style={styles.name}>{dayTitle(d.date, props.locale)}</Text>
                  <Text style={styles.muted}>
                    {fill(r.tillClosesRow, {
                      counted: money(d.countedCashGrosze),
                      expected: money(d.expectedCashGrosze),
                      difference: signed(d.differenceGrosze, money),
                    })}
                  </Text>
                  {d.cashInGrosze > 0 || d.cashOutGrosze > 0 ? (
                    // Task 237: cash put in or taken out that day (task 236).
                    <Text style={styles.muted}>
                      {fill(r.tillClosesMoves, {
                        in: money(d.cashInGrosze),
                        out: money(d.cashOutGrosze),
                      })}
                    </Text>
                  ) : null}
                </View>
              ))}
              <Text style={styles.muted}>{r.tillClosesHint}</Text>
            </View>
          ) : null}
          {shown.busyHours.length > 0 ? (
            <View style={{ gap: 6 }} testID="report-busy-hours">
              <Text style={styles.section}>{r.busyHours}</Text>
              {peakHours(shown.busyHours).map((c) => (
                <View key={`${c.weekday}-${c.hour}`} style={styles.cardTop}>
                  <Text style={styles.name}>
                    {weekdayLong(c.weekday, props.locale)}, {String(c.hour).padStart(2, '0')}:00
                  </Text>
                  <Text style={styles.muted}>{fill(r.weekdayVisits, { n: String(c.visits) })}</Text>
                </View>
              ))}
              <Text style={styles.small}>{r.busyHoursHint}</Text>
            </View>
          ) : null}
          {shown.topClients.length > 0 ? (
            <View style={{ gap: 8 }} testID="report-top-clients">
              <Text style={styles.section}>{r.topClients}</Text>
              {shown.topClients.map((c) => (
                <Pressable
                  key={c.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${c.name} · ${money(c.revenueGrosze)}`}
                  onPress={() => setClientId(c.id)}
                  style={({ pressed }) => pressed && { opacity: 0.7 }}
                >
                  <Card>
                    <View style={styles.cardTop}>
                      <Text style={styles.name}>{c.name}</Text>
                      <Text style={styles.name}>{money(c.revenueGrosze)}</Text>
                    </View>
                    <Text style={styles.muted}>
                      {fill(r.topClientVisits, { n: String(c.completed) })}
                    </Text>
                  </Card>
                </Pressable>
              ))}
              <Text style={styles.small}>{r.topClientsHint}</Text>
            </View>
          ) : null}
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
          {shown.rebooking.clients > 0 ? (
            <View style={{ gap: 6 }} testID="report-rebooking">
              <Text style={styles.section}>
                {fill(r.rebooking, { n: String(shown.rebooking.percent) })}
              </Text>
              <Text style={styles.small}>
                {fill(r.rebookingCount, {
                  rebooked: String(shown.rebooking.rebooked),
                  clients: String(shown.rebooking.clients),
                })}
              </Text>
              {shown.scope !== 'own'
                ? shown.rebooking.staff.map((s) => (
                    <View key={s.id} style={styles.weekday}>
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
                      <Text style={styles.small}>
                        {fill(r.rebookingStaff, {
                          n: String(s.percent),
                          rebooked: String(s.rebooked),
                          clients: String(s.clients),
                        })}
                      </Text>
                    </View>
                  ))
                : null}
              <Text style={styles.small}>{r.rebookingHint}</Text>
            </View>
          ) : null}
          {shown.newcomers.clients > 0 ? (
            <View style={{ gap: 6 }} testID="report-newcomers">
              <Text style={styles.section}>
                {fill(r.newcomers, { n: String(shown.newcomers.percent) })}
              </Text>
              <View
                style={styles.bar}
                accessibilityRole="progressbar"
                accessibilityLabel={fill(r.newcomers, { n: String(shown.newcomers.percent) })}
                accessibilityValue={{ min: 0, max: 100, now: shown.newcomers.percent }}
              >
                <View
                  style={[styles.barFill, { width: `${Math.min(100, shown.newcomers.percent)}%` }]}
                />
              </View>
              <Text style={styles.small}>
                {fill(r.newcomersCount, {
                  returned: String(shown.newcomers.returned),
                  booked: String(shown.newcomers.booked),
                  clients: String(shown.newcomers.clients),
                })}
              </Text>
              {shown.scope !== 'own' && shown.newcomers.staff.length > 1
                ? shown.newcomers.staff.map((s) => (
                    <Text key={s.id} style={styles.small}>
                      {s.displayName}:{' '}
                      {fill(r.newcomersCount, {
                        returned: String(s.returned),
                        booked: String(s.booked),
                        clients: String(s.clients),
                      })}
                    </Text>
                  ))
                : null}
              <Text style={styles.small}>{r.newcomersHint}</Text>
            </View>
          ) : null}
          {shown.scope !== 'own' && shown.marketing.clients > 0 ? (
            <View style={{ gap: 6 }} testID="report-marketing">
              <Text style={styles.section}>
                {fill(r.marketing, { n: String(shown.marketing.percent) })}
              </Text>
              <View
                style={styles.bar}
                accessibilityRole="progressbar"
                accessibilityLabel={fill(r.marketing, { n: String(shown.marketing.percent) })}
                accessibilityValue={{ min: 0, max: 100, now: shown.marketing.percent }}
              >
                <View
                  style={[styles.barFill, { width: `${Math.min(100, shown.marketing.percent)}%` }]}
                />
              </View>
              <Text style={styles.small}>
                {fill(r.marketingCount, {
                  consented: String(shown.marketing.consented),
                  clients: String(shown.marketing.clients),
                })}
                {' · '}
                {fill(r.marketingNew, { n: String(shown.marketing.newInPeriod) })}
                {shown.marketing.unsubscribed > 0
                  ? ` · ${fill(r.marketingUnsubscribed, {
                      n: String(shown.marketing.unsubscribed),
                    })}`
                  : null}
              </Text>
              <Text style={styles.small}>{r.marketingHint}</Text>
            </View>
          ) : null}
        </>
      ) : !error ? (
        <Text style={styles.muted}>{t.loading}</Text>
      ) : null}
    </ScrollView>
  );
}

/** What this platform can do with the CSV: save the file in a browser, the share sheet on a phone. */
function csvTools(): CsvShareTools {
  if (Platform.OS !== 'web') {
    return { native: (c) => Share.share({ message: c.message, title: c.title }) };
  }
  return {
    download: (fileName, csv) => {
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
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
