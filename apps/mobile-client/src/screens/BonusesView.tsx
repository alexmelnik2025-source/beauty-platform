import { useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { bookingUrl, type ClientLoyaltyCard, type Locale } from '../api';
import {
  earningText,
  formatDate,
  nextText,
  progress,
  readyReward,
  rewardText,
  signedPoints,
} from '../bonus';
import { WEB_URL } from '../config';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors } from '../ui';

/** "My bonuses": a card per salon — stamps or points, rewards, coupons and history. */
export function BonusesView(props: { t: Dictionary; locale: Locale; items: ClientLoyaltyCard[] }) {
  const { t, locale, items } = props;
  if (items.length === 0) return <Text style={styles.empty}>{t.bonuses.empty}</Text>;
  return (
    <View style={{ gap: 16 }}>
      {items.map((card) => (
        <BonusCard key={card.organization.id} t={t} locale={locale} card={card} />
      ))}
    </View>
  );
}

function BonusCard({
  t,
  locale,
  card,
}: {
  t: Dictionary;
  locale: Locale;
  card: ClientLoyaltyCard;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const stamps = card.mode === 'stamps';
  const ready = readyReward(card);
  const next = nextText(t, card);
  const bar = progress(t, card);
  const count = (n: number) =>
    fill(stamps ? t.bonuses.stampsCount : t.bonuses.pointsCount, { count: String(n) });

  return (
    <View role="region" aria-label={card.organization.name}>
      <Card>
        <Text role="heading" aria-level={2} style={styles.salon}>
          {card.organization.name}
        </Text>
        {!card.enabled ? <Text style={styles.muted}>{t.bonuses.programOff}</Text> : null}

        {card.enabled ? (
          <View style={{ gap: 8, marginTop: 4 }}>
            <Text style={styles.balance}>
              {fill(stamps ? t.bonuses.balanceStamps : t.bonuses.balancePoints, {
                count: String(card.balance),
              })}
            </Text>
            {bar?.kind === 'stamps' ? (
              <View role="list" aria-label={bar.label} style={styles.stamps}>
                {bar.stamps.map((s, i) => (
                  <View
                    key={i}
                    role="listitem"
                    style={[styles.stamp, s.reward && styles.stampReward, s.on && styles.stampOn]}
                  >
                    <Text style={[styles.stampText, s.on && { color: '#fff' }]}>
                      {s.reward ? '★' : i + 1}
                    </Text>
                  </View>
                ))}
              </View>
            ) : bar ? (
              <View
                role="progressbar"
                aria-label={bar.label}
                aria-valuemin={0}
                aria-valuemax={bar.max}
                aria-valuenow={bar.value}
                style={styles.bar}
              >
                <View
                  style={[
                    styles.barFill,
                    { width: `${Math.min(100, (bar.value / bar.max) * 100)}%` as `${number}%` },
                  ]}
                />
              </View>
            ) : null}
            {ready ? (
              <Text role="status" style={styles.ready}>
                {fill(stamps ? t.bonuses.readyStamps : t.bonuses.readyPoints, {
                  count: String(card.balance),
                  reward: ready.name,
                })}{' '}
                {t.bonuses.askSalon}
              </Text>
            ) : null}
            {next ? <Text style={styles.text}>{next}</Text> : null}
            <Text style={styles.muted}>{earningText(t, card, locale)}</Text>

            {card.rewards.length ? (
              <View style={{ gap: 6, marginTop: 6 }}>
                <Text role="heading" aria-level={3} style={styles.section}>
                  {t.bonuses.rewards}
                </Text>
                <View role="list" aria-label={`${t.bonuses.rewards}: ${card.organization.name}`}>
                  {card.rewards.map((r) => (
                    <View key={r.id} role="listitem" style={styles.row}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.strong}>{r.name}</Text>
                        <Text style={styles.muted}>
                          {rewardText(t, r)} · {count(r.cost)}
                          {r.serviceNames.length
                            ? ` · ${fill(t.bonuses.onlyFor, { services: r.serviceNames.join(', ') })}`
                            : ''}
                        </Text>
                      </View>
                      <Text style={[styles.chip, r.missing === 0 && styles.chipReady]}>
                        {r.missing === 0
                          ? t.bonuses.available
                          : fill(t.bonuses.left, { count: String(r.missing) })}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        ) : null}

        {card.coupons.length ? (
          <View style={{ gap: 6, marginTop: 10 }}>
            <Text role="heading" aria-level={3} style={styles.section}>
              {t.bonuses.coupons}
            </Text>
            <Text style={styles.muted}>{t.bonuses.couponHint}</Text>
            <View role="list" aria-label={t.bonuses.coupons}>
              {card.coupons.map((c) => (
                <View key={c.id} role="listitem" style={styles.row}>
                  <View style={{ flex: 1, opacity: c.status === 'active' ? 1 : 0.55 }}>
                    <Text style={styles.strong}>
                      <Text selectable style={styles.code}>
                        {c.code}
                      </Text>{' '}
                      · {c.name}
                    </Text>
                    <Text style={styles.muted}>
                      {rewardText(t, c)}
                      {c.serviceNames.length
                        ? ` · ${fill(t.bonuses.onlyFor, { services: c.serviceNames.join(', ') })}`
                        : ''}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', maxWidth: '40%' }}>
                    <Text style={styles.text}>{t.bonuses.coupon[c.status]}</Text>
                    {c.status === 'active' && c.expiresAt ? (
                      <Text style={styles.muted}>
                        {fill(t.bonuses.validUntil, { date: formatDate(c.expiresAt, locale) })}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {card.history.length ? (
          <View style={{ gap: 6, marginTop: 10 }}>
            <Button
              kind="link"
              label={showHistory ? t.bonuses.hideHistory : t.bonuses.showHistory}
              onPress={() => setShowHistory((v) => !v)}
            />
            {showHistory ? (
              <>
                <View role="list" aria-label={t.bonuses.history}>
                  {card.history.map((h) => (
                    <View key={h.id} role="listitem" style={styles.row}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.text}>
                          {t.bonuses.type[h.type]}
                          {h.serviceName ? ` · ${h.serviceName}` : ''}
                        </Text>
                        <Text style={styles.muted}>
                          {formatDate(h.createdAt, locale)}
                          {h.expiresAt && h.points > 0
                            ? ` · ${fill(t.bonuses.validUntil, { date: formatDate(h.expiresAt, locale) })}`
                            : ''}
                        </Text>
                      </View>
                      <Text style={styles.strong}>{signedPoints(h.points)}</Text>
                    </View>
                  ))}
                </View>
                <Text style={styles.muted}>
                  {fill(t.bonuses.lifetime, { count: String(card.lifetimeEarned) })}
                </Text>
              </>
            ) : null}
          </View>
        ) : null}

        {card.bookingSlug ? (
          <View style={{ marginTop: 10 }}>
            <Button
              kind="secondary"
              label={t.bonuses.book}
              onPress={() =>
                void Linking.openURL(bookingUrl(WEB_URL, locale, card.bookingSlug as string))
              }
            />
          </View>
        ) : null}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { color: colors.muted, fontSize: 16, textAlign: 'center', paddingVertical: 32 },
  salon: { fontSize: 19, fontWeight: '700', color: colors.ink },
  balance: { fontSize: 17, fontWeight: '700', color: colors.ink },
  section: { fontSize: 15, fontWeight: '700', color: colors.ink },
  text: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  strong: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  ready: {
    color: '#1e6b3a',
    backgroundColor: '#eef7f0',
    borderRadius: 10,
    padding: 10,
    fontSize: 15,
    lineHeight: 21,
  },
  stamps: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stamp: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stampReward: { borderColor: colors.gold },
  stampOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  stampText: { color: colors.muted, fontSize: 14, fontWeight: '700' },
  bar: { height: 10, borderRadius: 5, backgroundColor: colors.line, overflow: 'hidden' },
  barFill: { height: 10, backgroundColor: colors.gold },
  row: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  code: { fontFamily: 'monospace', fontWeight: '700', letterSpacing: 1 },
  chip: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  chipReady: { color: '#1e6b3a', borderColor: '#b9dcc4', backgroundColor: '#eef7f0' },
});
