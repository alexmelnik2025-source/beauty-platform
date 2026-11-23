import { useCallback, useEffect, useState } from 'react';
import {
  BackHandler,
  Platform,
  RefreshControl,
  ScrollView,
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
  dayBars,
  onlineShare,
  peakHours,
  REPORT_PERIODS,
  reportRange,
  shortDay,
  starsText,
  weekdayLong,
  type ReportPeriod,
} from '../reports';
import { shareCsv } from '../share';
import { signed } from '../tillClose';
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
import { ClientScreen } from './ClientScreen';
import { CommissionsSection } from './CommissionsSection';
import { csvTools } from './csvTools';
import { ClientsScreen } from './ClientsScreen';
import type { SalonChoice } from './SalonsScreen';

/**
 * "Raporty" (task 15): revenue, visits, clients, specialists and services for a period — the
 * same report as in the cabinet. A specialist gets only their own visits (the server decides).
 */
/** Task 260: the label of each "how far ahead" bucket. */
const LEAD_LABELS = {
  sameDay: 'leadSameDay',
  nextDay: 'leadNextDay',
  week: 'leadWeek',
  twoWeeks: 'leadTwoWeeks',
  later: 'leadLater',
} as const;

/** Task 304: the label of each kind of discount. */
const DISCOUNT_LABELS = {
  coupon: 'discountCoupon',
  tier: 'discountTier',
  happyHours: 'discountHappyHours',
} as const;

/** Task 294: the label of each "how long before the visit" bucket of cancellations. */
/** Task Q2: the label of a booking channel; a utm_source of the salon's own link is shown as it is. */
const CHANNEL_LABELS: Record<
  string,
  'channelQr' | 'channelEmbed' | 'channelApp' | 'channelCatalogue' | 'channelWeb' | 'channelUnknown'
> = {
  qr: 'channelQr',
  embed: 'channelEmbed',
  app: 'channelApp',
  catalogue: 'channelCatalogue',
  web: 'channelWeb',
  unknown: 'channelUnknown',
};

const NOTICE_LABELS = {
  twoHours: 'noticeTwoHours',
  day: 'noticeDay',
  threeDays: 'noticeThreeDays',
  later: 'noticeLater',
} as const;

export function ReportsScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  today: string;
  /** Task 217: a top client's card opens with the salon's time zone. */
  timeZone: string;
  onBack: () => void;
  /** Task 358: a day of "Dzień po dniu" opens in the calendar. */
  onOpenDay?: (date: string) => void;
}) {
  const { api, t, salon, today, onBack } = props;
  const r = t.reports;
  const [period, setPeriod] = useState<ReportPeriod>('thisMonth');
  const [report, setReport] = useState<SalonReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [clientId, setClientId] = useState<string | null>(null);
  // Task 249: "Pokaż nowych klientów" opens the client list with the new clients.
  const [newcomersOpen, setNewcomersOpen] = useState(false);
  // Task 263: "Pokaż, komu pora wrócić" opens the client list with "Pora wrócić" on.
  const [overdueOpen, setOverdueOpen] = useState(false);
  // Task 265: "Pokaż, kto nie przyszedł" opens the client list with "Nie przyszli" on.
  const [noShowsOpen, setNoShowsOpen] = useState(false);
  // Task 271: "Pokaż, kto był tylko raz" opens the client list with "Byli tylko raz" on.
  const [onceOpen, setOnceOpen] = useState(false);
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
  // Task 393: "payout" — commission, tips and the total by specialist (owners and managers).
  // Task 423: "products" — every product sold at the visits of the period (same as the report).
  // Task 455: "stock-history" — every change of the stock in the period (owners and managers).
  const downloadCsv = async (
    kind: 'visits' | 'till' | 'payout' | 'products' | 'stock-history' = 'visits',
  ) => {
    if (csvBusy) return;
    setCsvBusy(true);
    setCsvInfo('');
    try {
      const file = await (
        kind === 'till'
          ? api.tillCsv
          : kind === 'payout'
            ? api.payoutCsv
            : kind === 'products'
              ? api.productsCsv
              : kind === 'stock-history'
                ? api.stockHistoryCsv
                : api.visitsCsv
      ).call(api, salon.orgId, salon.locationId, range.from, range.to, props.locale);
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
  const channelLabel = (key: string): string => {
    const label = CHANNEL_LABELS[key];
    return label ? r[label] : key;
  };
  const totals = shown?.totals;

  const previous = shown?.previous;
  /** Task 141: minutes as hours, "12,5". */
  const hours = (minutes: number) =>
    new Intl.NumberFormat(props.locale, { maximumFractionDigits: 1 }).format(minutes / 60);
  const ratings = shown?.ratings;
  const maxStars = Math.max(1, ...(ratings?.stars ?? [1]));
  const maxWeekday = Math.max(1, ...(shown?.weekdays.map((d) => d.completed) ?? [1]));
  const days = shown ? dayBars(shown.days) : [];
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

  if (onceOpen) {
    return (
      <ClientsScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        timeZone={props.timeZone}
        once
        onBack={() => setOnceOpen(false)}
      />
    );
  }

  if (noShowsOpen) {
    return (
      <ClientsScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        timeZone={props.timeZone}
        noShows
        onBack={() => setNoShowsOpen(false)}
      />
    );
  }

  if (overdueOpen) {
    return (
      <ClientsScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        timeZone={props.timeZone}
        overdue
        onBack={() => setOverdueOpen(false)}
      />
    );
  }

  if (newcomersOpen) {
    return (
      <ClientsScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        timeZone={props.timeZone}
        newcomers
        onBack={() => setNewcomersOpen(false)}
      />
    );
  }

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
              <Button
                kind="secondary"
                label={csvBusy ? t.loading : r.payoutCsv}
                onPress={() => void downloadCsv('payout')}
              />
              <Text style={styles.small}>{r.payoutCsvHint}</Text>
              <Button
                kind="secondary"
                label={csvBusy ? t.loading : r.stockHistoryCsv}
                onPress={() => void downloadCsv('stock-history')}
              />
              <Text style={styles.small}>{r.stockHistoryCsvHint}</Text>
            </View>
          ) : null}

          {totals.visits === 0 ? (
            <Text style={styles.muted}>{r.empty}</Text>
          ) : (
            (
              [
                [r.byStaff, shown.staff.map((s) => ({ ...s, name: s.displayName }))],
                [r.byService, shown.services],
                // Task 256: by price-list category, when the price list is grouped.
                [
                  r.byCategory,
                  shown.categories.map((c) => ({
                    ...c,
                    id: c.id ?? 'none',
                    name: c.name ?? r.noCategory,
                  })),
                ],
              ] as const
            )
              .filter(([, rows]) => rows.length > 0)
              .map(([title, rows]) => (
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
          {/* Task 375: "Prowizje" — after the specialists' revenue. */}
          <CommissionsSection
            api={api}
            t={t}
            locale={props.locale}
            salon={salon}
            report={shown}
            money={money}
            onSaved={() => void load()}
          />
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
          {shown.products.totalGrosze > 0 ? (
            // Task 396: products sold at the visits — not part of the visit revenue.
            <View style={{ gap: 6 }} testID="report-products">
              <Text style={styles.section}>
                {fill(r.products, { amount: money(shown.products.totalGrosze) })}
              </Text>
              {shown.products.items.map((item) => (
                <View key={item.name} style={styles.cardTop}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.muted}>
                    {fill(r.productsRow, {
                      n: String(item.quantity),
                      amount: money(item.totalGrosze),
                    })}
                    {item.marginGrosze === null
                      ? ''
                      : ` · ${fill(r.marginItem, { amount: money(item.marginGrosze) })}`}
                  </Text>
                </View>
              ))}
              {shown.products.suppliers.some((x) => x.supplier !== null) ? (
                // Task 472: the same sales by supplier — whose products sell.
                <View style={{ gap: 6 }} testID="report-products-suppliers">
                  <Text style={styles.name}>{r.deliveriesBySupplier}</Text>
                  {shown.products.suppliers.map((group) => (
                    <View key={group.supplier ?? ''} style={styles.cardTop}>
                      <Text style={styles.name}>{group.supplier ?? r.deliveriesNoSupplier}</Text>
                      <Text style={styles.muted}>
                        {fill(r.productsRow, {
                          n: String(group.quantity),
                          amount: money(group.totalGrosze),
                        })}
                        {group.marginGrosze === null
                          ? ''
                          : ` · ${fill(r.marginItem, { amount: money(group.marginGrosze) })}`}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {shown.products.margin ? (
                // Task 449: "Marża" — only pieces sold with a purchase price.
                <Text style={styles.name} testID="report-products-margin">
                  {fill(r.margin, {
                    amount: money(shown.products.margin.marginGrosze),
                    n: String(shown.products.margin.quantity),
                    sales: money(shown.products.margin.salesGrosze),
                    cost: money(shown.products.margin.costGrosze),
                  })}
                </Text>
              ) : null}
              <Text style={styles.muted}>{r.productsHint}</Text>
              <Button
                kind="secondary"
                label={csvBusy ? t.loading : r.productsCsv}
                onPress={() => void downloadCsv('products')}
              />
              <Text style={styles.small}>{r.productsCsvHint}</Text>
            </View>
          ) : null}
          {shown.writeOffs.quantity > 0 ? (
            // Task 447: pieces used in the salon, damaged or lost — at today's prices.
            <View style={{ gap: 6 }} testID="report-write-offs">
              <Text style={styles.section}>
                {fill(r.writeOffs, {
                  amount: money(shown.writeOffs.valueGrosze),
                  n: String(shown.writeOffs.quantity),
                })}
              </Text>
              {shown.writeOffs.items.map((item) => (
                <View key={item.name} style={styles.cardTop}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.muted}>
                    {fill(r.productsRow, {
                      n: String(item.quantity),
                      amount: money(item.valueGrosze),
                    })}
                  </Text>
                </View>
              ))}
              <Text style={styles.muted}>{r.writeOffsHint}</Text>
            </View>
          ) : null}
          {shown.deliveries.quantity > 0 ? (
            // Task 453: pieces that arrived from suppliers — at today's purchase prices.
            <View style={{ gap: 6 }} testID="report-deliveries">
              <Text style={styles.section}>
                {fill(r.deliveries, { n: String(shown.deliveries.quantity) })}
              </Text>
              {shown.deliveries.items.map((item) => (
                <View key={item.name} style={styles.cardTop}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.muted}>
                    {item.costGrosze === null
                      ? fill(r.deliveriesPieces, { n: String(item.quantity) })
                      : fill(r.deliveriesRow, {
                          n: String(item.quantity),
                          amount: money(item.costGrosze),
                        })}
                  </Text>
                </View>
              ))}
              {shown.deliveries.costGrosze !== null ? (
                <Text style={styles.name} testID="report-deliveries-cost">
                  {fill(r.deliveriesCost, { amount: money(shown.deliveries.costGrosze) })}
                </Text>
              ) : null}
              {shown.deliveries.suppliers.some((x) => x.supplier !== null) ? (
                // Task 468: the same pieces by supplier — how much came from whom.
                <View style={{ gap: 6 }} testID="report-deliveries-suppliers">
                  <Text style={styles.name}>{r.deliveriesBySupplier}</Text>
                  {shown.deliveries.suppliers.map((group) => (
                    <View key={group.supplier ?? ''} style={styles.cardTop}>
                      <Text style={styles.name}>{group.supplier ?? r.deliveriesNoSupplier}</Text>
                      <Text style={styles.muted}>
                        {group.costGrosze === null
                          ? fill(r.deliveriesPieces, { n: String(group.quantity) })
                          : fill(r.deliveriesRow, {
                              n: String(group.quantity),
                              amount: money(group.costGrosze),
                            })}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
              <Text style={styles.muted}>{r.deliveriesHint}</Text>
            </View>
          ) : null}
          {shown.stocktakes.missingQuantity + shown.stocktakes.extraQuantity > 0 ? (
            // Task 459: what the stocktakes found missing or extra — at today's prices.
            <View style={{ gap: 6 }} testID="report-stocktakes">
              <Text style={styles.section}>
                {fill(r.stocktakes, {
                  missing: String(shown.stocktakes.missingQuantity),
                  missingAmount: money(shown.stocktakes.missingGrosze),
                  extra: String(shown.stocktakes.extraQuantity),
                  extraAmount: money(shown.stocktakes.extraGrosze),
                })}
              </Text>
              {shown.stocktakes.items.map((item) => (
                <View key={item.name} style={styles.cardTop}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.muted}>
                    {[
                      item.missing > 0
                        ? fill(r.stocktakesMissing, {
                            n: String(item.missing),
                            amount: money(item.missingGrosze),
                          })
                        : '',
                      item.extra > 0
                        ? fill(r.stocktakesExtra, {
                            n: String(item.extra),
                            amount: money(item.extraGrosze),
                          })
                        : '',
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </Text>
                </View>
              ))}
              <Text style={styles.muted}>{r.stocktakesHint}</Text>
            </View>
          ) : null}
          {shown.idleProducts.items.length > 0 ? (
            // Task 460: counted products on the shelf that no visit of the period sold.
            <View style={{ gap: 6 }} testID="report-idle-products">
              <Text style={styles.section}>
                {fill(r.idleProducts, {
                  n: String(shown.idleProducts.quantity),
                  amount: money(shown.idleProducts.valueGrosze),
                })}
              </Text>
              {shown.idleProducts.items.map((item) => (
                <View key={item.name} style={styles.cardTop}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.muted}>
                    {fill(r.idleProductsItem, {
                      n: String(item.stock),
                      amount: money(item.valueGrosze),
                    })}
                    {' · '}
                    {item.lastSoldOn
                      ? fill(r.idleProductsLast, { day: shortDay(item.lastSoldOn, props.locale) })
                      : r.idleProductsNever}
                  </Text>
                </View>
              ))}
              <Text style={styles.muted}>{r.idleProductsHint}</Text>
            </View>
          ) : null}
          {shown.giftVouchers.sold > 0 ||
          shown.giftVouchers.payments > 0 ||
          shown.giftVouchers.activeBalanceGrosze > 0 ||
          shown.giftVouchers.expired > 0 ? (
            // Task 493: gift vouchers sold and paid with in the period, what is left today.
            <View style={{ gap: 6 }} testID="report-gift-vouchers">
              <Text style={styles.section}>{r.vouchersTitle}</Text>
              <Text style={styles.name}>
                {fill(r.vouchersSold, {
                  n: String(shown.giftVouchers.sold),
                  amount: money(shown.giftVouchers.soldGrosze),
                })}
              </Text>
              {/* Task 551: how the clients paid for the vouchers sold. */}
              {shown.giftVouchers.soldByPayment.map((p) => (
                <Text key={p.method} style={styles.muted}>
                  {fill(r.vouchersSoldBy, {
                    method:
                      p.method === 'unknown' ? r.paymentsUnknown : t.visit.paymentMethods[p.method],
                    n: String(p.sold),
                    amount: money(p.soldGrosze),
                  })}
                </Text>
              ))}
              <Text style={styles.name}>
                {fill(r.vouchersPaid, {
                  n: String(shown.giftVouchers.payments),
                  amount: money(shown.giftVouchers.paidGrosze),
                })}
              </Text>
              <Text style={styles.name}>
                {fill(r.vouchersLeft, { amount: money(shown.giftVouchers.activeBalanceGrosze) })}
              </Text>
              {shown.giftVouchers.expired > 0 ? (
                // Task 551: what was left on the vouchers whose last day passed in the period.
                <Text style={styles.name} testID="report-vouchers-expired">
                  {fill(r.vouchersExpired, {
                    n: String(shown.giftVouchers.expired),
                    amount: money(shown.giftVouchers.expiredGrosze),
                  })}
                </Text>
              ) : null}
              <Text style={styles.muted}>{r.vouchersHint}</Text>
            </View>
          ) : null}
          {shown.discounts.totalGrosze > 0 ? (
            // Task 304: what the salon gave away — coupons, tier discounts and happy hours.
            <View style={{ gap: 6 }} testID="report-discounts">
              <Text style={styles.section}>
                {fill(r.discountKinds, { amount: money(shown.discounts.totalGrosze) })}
              </Text>
              {shown.discounts.kinds
                .filter((k) => k.visits > 0)
                .map((k) => (
                  <View key={k.key} style={styles.cardTop}>
                    <Text style={styles.name}>{r[DISCOUNT_LABELS[k.key]]}</Text>
                    <Text style={styles.muted}>
                      {fill(r.discountRow, { amount: money(k.grosze), n: String(k.visits) })}
                    </Text>
                  </View>
                ))}
              <Text style={styles.muted}>{r.discountHint}</Text>
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
                  {d.nonCashGrosze > 0 ? (
                    // Task 553: what that day brought not in cash — to check with the terminal.
                    <Text style={styles.muted}>
                      {fill(r.tillClosesNonCash, { sum: money(d.nonCashGrosze) })}
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
          {shown.unbookedServices.length > 0 ? (
            <View style={{ gap: 8 }} testID="report-unbooked">
              <Text style={styles.section}>{r.unbooked}</Text>
              {shown.unbookedServices.map((s) => (
                <Card key={s.id}>
                  <View style={styles.cardTop}>
                    <Text style={styles.name}>{s.name}</Text>
                    <Text style={styles.name}>{money(s.priceGrosze)}</Text>
                  </View>
                  {s.categoryName ? <Text style={styles.muted}>{s.categoryName}</Text> : null}
                </Card>
              ))}
              <Text style={styles.small}>{r.unbookedHint}</Text>
            </View>
          ) : null}
          {shown.leadTime.visits > 0 ? (
            <View style={{ gap: 6 }} testID="report-lead-time">
              <Text style={styles.section}>
                {fill(r.leadTime, { n: String(shown.leadTime.medianDays ?? 0) })}
              </Text>
              {shown.leadTime.buckets.map((b) => (
                <View key={b.key} style={styles.weekday}>
                  <Text style={styles.weekdayName}>{r[LEAD_LABELS[b.key]]}</Text>
                  <View style={styles.bar}>
                    <View
                      style={[
                        styles.barFill,
                        { width: `${(b.visits / shown.leadTime.visits) * 100}%` },
                      ]}
                    />
                  </View>
                  <Text style={styles.small}>{fill(r.weekdayVisits, { n: String(b.visits) })}</Text>
                </View>
              ))}
              <Text style={styles.small}>{r.leadHint}</Text>
            </View>
          ) : null}
          {shown.cancelNotice.cancelled > 0 ? (
            <View style={{ gap: 6 }} testID="report-cancel-notice">
              <Text style={styles.section}>{r.cancelNotice}</Text>
              {shown.cancelNotice.buckets.map((b) => (
                <View key={b.key} style={styles.weekday}>
                  <Text style={styles.weekdayName}>{r[NOTICE_LABELS[b.key]]}</Text>
                  <View style={styles.bar}>
                    <View
                      style={[
                        styles.barFill,
                        { width: `${(b.cancelled / shown.cancelNotice.cancelled) * 100}%` },
                      ]}
                    />
                  </View>
                  <Text style={styles.small}>
                    {fill(r.noticeCancelled, { n: String(b.cancelled) })}
                  </Text>
                </View>
              ))}
              <Text style={styles.small}>{r.noticeHint}</Text>
            </View>
          ) : null}
          {shown.channels.online > 0 ? (
            <View style={{ gap: 6 }} testID="report-channels">
              <Text style={styles.section}>{r.channels}</Text>
              {shown.channels.items.map((c) => (
                <View key={c.key} style={styles.weekday}>
                  <Text style={styles.weekdayName}>{channelLabel(c.key)}</Text>
                  <View style={styles.bar}>
                    <View
                      style={[
                        styles.barFill,
                        { width: `${(c.visits / shown.channels.online) * 100}%` },
                      ]}
                    />
                  </View>
                  <Text style={styles.small}>
                    {fill(r.channelVisits, { n: String(c.visits) })}
                    {c.newClients > 0
                      ? ` · ${fill(r.channelNew, { n: String(c.newClients) })}`
                      : ''}
                  </Text>
                </View>
              ))}
              {shown.channels.qrStaff.length > 0 ? (
                <Text style={styles.small} testID="report-channels-qr-staff">
                  {r.channelQrStaff}:{' '}
                  {shown.channels.qrStaff
                    .map((s) => `${s.name} — ${fill(r.channelVisits, { n: String(s.visits) })}`)
                    .join(', ')}
                </Text>
              ) : null}
              <Text style={styles.small}>{r.channelsHint}</Text>
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
          {days.length > 0 ? (
            <View style={{ gap: 6 }} testID="report-days">
              <Text style={styles.section}>{r.byDay}</Text>
              {days.map((d) => (
                <Pressable
                  key={d.date}
                  style={styles.weekday}
                  role="button"
                  disabled={!props.onOpenDay}
                  onPress={() => props.onOpenDay?.(d.date)}
                  accessibilityLabel={`${shortDay(d.date, props.locale)} · ${
                    d.revenueGrosze ? money(d.revenueGrosze) : '—'
                  } · ${fill(r.weekdayVisits, { n: String(d.completed) })}`}
                  accessibilityHint={r.byDayOpen}
                >
                  <Text style={[styles.dayName, d.best && styles.bestDay]}>
                    {shortDay(d.date, props.locale)}
                  </Text>
                  <View style={styles.bar}>
                    <View style={[styles.barFill, { width: `${d.share * 100}%` }]} />
                  </View>
                  <Text style={[styles.dayValue, d.best && styles.bestDay]}>
                    {d.revenueGrosze ? money(d.revenueGrosze) : '—'}
                  </Text>
                  <Text style={styles.dayVisits}>{d.completed || ''}</Text>
                </Pressable>
              ))}
              <Text style={styles.small}>{r.byDayHint}</Text>
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
                    <Text style={styles.weekdayName}>{s.displayName}</Text>
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
                    {s.revenuePerHourGrosze !== null
                      ? ` · ${fill(r.occupancyPerHour, { money: money(s.revenuePerHourGrosze) })}`
                      : ''}
                  </Text>
                </View>
              ))}
              {shown.occupancy.revenuePerHourGrosze !== null ? (
                <Text style={styles.name} testID="report-occupancy-per-hour">
                  {fill(r.occupancyPerHour, {
                    money: money(shown.occupancy.revenuePerHourGrosze),
                  })}
                </Text>
              ) : null}
              <Text style={styles.small}>{r.occupancyHint}</Text>
              <Text style={styles.small}>{r.occupancyPerHourHint}</Text>
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
                      <Text style={[styles.weekdayName, { flexGrow: 1 }]}>{s.displayName}</Text>
                      <Text style={styles.small}>
                        {fill(r.ratingsStaff, {
                          stars: starsText(s.average, props.locale),
                          n: String(s.reviews),
                        })}
                      </Text>
                    </View>
                  ))
                : null}
              {ratings.services.length > 0 ? (
                <Text style={styles.small} accessibilityRole="header">
                  {r.ratingsServices}
                </Text>
              ) : null}
              {ratings.services.map((s) => (
                <View key={s.id} style={styles.weekday}>
                  <Text style={[styles.weekdayName, { flexGrow: 1 }]}>{s.name}</Text>
                  <Text style={styles.small}>
                    {fill(r.ratingsStaff, {
                      stars: starsText(s.average, props.locale),
                      n: String(s.reviews),
                    })}
                  </Text>
                </View>
              ))}
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
                      <Text style={styles.weekdayName}>{s.displayName}</Text>
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
              {shown.scope !== 'own' ? (
                <Button
                  kind="link"
                  label={r.newcomersList}
                  onPress={() => setNewcomersOpen(true)}
                />
              ) : null}
              <Text style={styles.small}>{r.newcomersHint}</Text>
            </View>
          ) : null}
          {shown.returnInterval.intervals > 0 ? (
            <View style={{ gap: 6 }} testID="report-return-interval">
              <Text style={styles.section}>{r.returnInterval}</Text>
              <Text style={styles.small}>
                {fill(r.returnIntervalCount, {
                  median: String(shown.returnInterval.medianDays),
                  average: String(shown.returnInterval.averageDays),
                  n: String(shown.returnInterval.intervals),
                })}
              </Text>
              {shown.scope !== 'own' && shown.returnInterval.staff.length > 1
                ? shown.returnInterval.staff.map((s) => (
                    <Text key={s.id} style={styles.small}>
                      {s.displayName}:{' '}
                      {fill(r.returnIntervalCount, {
                        median: String(s.medianDays),
                        average: String(s.averageDays),
                        n: String(s.intervals),
                      })}
                    </Text>
                  ))
                : null}
              <Text style={styles.small}>{r.returnIntervalHint}</Text>
            </View>
          ) : null}
          {shown.scope !== 'own' && shown.overdueClients > 0 ? (
            <View style={{ gap: 6 }} testID="report-overdue">
              <Text style={styles.section}>
                ⏰ {fill(r.overdueClients, { n: String(shown.overdueClients) })}
              </Text>
              <Button
                kind="link"
                label={r.overdueClientsList}
                onPress={() => setOverdueOpen(true)}
              />
              <Text style={styles.small}>{r.overdueClientsHint}</Text>
            </View>
          ) : null}
          {shown.scope !== 'own' && shown.noShowClients > 0 ? (
            <View style={{ gap: 6 }} testID="report-no-shows">
              <Text style={styles.section}>
                🚫 {fill(r.noShowClients, { n: String(shown.noShowClients) })}
              </Text>
              <Button
                kind="link"
                label={r.noShowClientsList}
                onPress={() => setNoShowsOpen(true)}
              />
              <Text style={styles.small}>{r.noShowClientsHint}</Text>
            </View>
          ) : null}
          {shown.scope !== 'own' && shown.onceClients > 0 ? (
            <View style={{ gap: 6 }} testID="report-once">
              <Text style={styles.section}>
                👋 {fill(r.onceClients, { n: String(shown.onceClients) })}
              </Text>
              <Button kind="link" label={r.onceClientsList} onPress={() => setOnceOpen(true)} />
              <Text style={styles.small}>{r.onceClientsHint}</Text>
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
  dayName: { width: 96, color: colors.ink, fontSize: 13 },
  dayValue: { width: 84, textAlign: 'right', color: colors.ink, fontSize: 13 },
  dayVisits: { width: 22, textAlign: 'right', color: colors.muted, fontSize: 13 },
  bestDay: { fontWeight: '700' },
});
