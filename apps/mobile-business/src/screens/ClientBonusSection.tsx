import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Locale, LoyaltyAccount, LoyaltyReward } from '../api';
import {
  bonusErrorText,
  cancellableCoupons,
  parseAdjustment,
  rewardChoices,
  showBonusCard,
} from '../clientBonus';
import { dateIn } from '../clients';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { costText, operationLine } from '../loyalty';
import { Button, Card, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 340: "Program lojalnościowy" in the client card (owners and managers only — the parent
 * shows it only then and the server checks again). Balance, tier and coupons as before (task
 * 18b), plus: exchange for a reward with a question first, cancelling an unused coupon, a manual
 * change with a reason, and the client's latest operations. As "Bonusy" in the cabinet.
 */
export function ClientBonusSection(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  customerId: string;
  timeZone: string;
  account: LoyaltyAccount;
  onAccount: (account: LoyaltyAccount) => void;
}) {
  const { api, t, salon, customerId, account } = props;
  const c = t.clients;
  const b = c.bonus;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [rewards, setRewards] = useState<LoyaltyReward[]>([]);
  const [ask, setAsk] = useState<{ kind: 'redeem' | 'cancel'; id: string } | null>(null);
  const [adjust, setAdjust] = useState<{ points: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([api.loyaltyProgram(salon.orgId), api.loyaltyRewards(salon.orgId)]).then(
      ([program, list]) => {
        if (!alive) return;
        setEnabled(program.enabled);
        setRewards(list);
      },
      () => alive && setEnabled(false),
    );
    return () => {
      alive = false;
    };
  }, [api, salon]);

  async function reload() {
    props.onAccount(await api.loyaltyAccount(salon.orgId, customerId));
  }

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setAsk(null);
    try {
      const done = await action();
      setNote({ text: done, bad: false });
    } catch (e) {
      setNote({ text: bonusErrorText(e, t) ?? errorText(e, t), bad: true });
      await reload().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  function saveAdjust() {
    if (!adjust) return;
    const checked = parseAdjustment(adjust.points, adjust.reason);
    if (!checked.ok) return setNote({ text: b.problem[checked.problem], bad: true });
    void run(async () => {
      props.onAccount(
        await api.adjustLoyaltyBalance(salon.orgId, customerId, checked.points, checked.reason),
      );
      setAdjust(null);
      return b.adjusted;
    });
  }

  if (enabled === null || !showBonusCard(account, enabled)) return null;

  const stamps = account.mode === 'stamps';
  const tier = account.tier?.current
    ? `${account.tier.current.name}${account.tier.current.discountPercent > 0 ? ` · −${account.tier.current.discountPercent}%` : ''}`
    : null;
  const coupons = cancellableCoupons(account);
  const choices = rewardChoices(account, rewards);

  return (
    <Card>
      <Text style={styles.label} role="heading">
        {c.bonuses}
      </Text>
      <Text style={styles.value}>
        {fill(stamps ? c.stamps : c.points, { count: String(account.balance) })}
      </Text>
      <Text style={styles.muted}>
        {fill(b.lifetime, { count: String(account.lifetimeEarned) })}
      </Text>
      {tier ? <Text style={styles.value}>{fill(c.tier, { tier })}</Text> : null}
      {!enabled ? <Text style={styles.muted}>{b.programOff}</Text> : null}
      {note ? (
        note.bad ? (
          <ErrorText>{note.text}</ErrorText>
        ) : (
          <Text role="status" style={styles.info}>
            {note.text}
          </Text>
        )
      ) : null}

      {coupons.length > 0 ? (
        <>
          <Text style={styles.label}>{c.coupons}</Text>
          {coupons.map((coupon) => (
            <View key={coupon.id} style={styles.item}>
              <Text style={styles.value}>
                {coupon.name} · {coupon.code}
                {coupon.expiresAt ? (
                  <Text style={styles.muted}>
                    {' '}
                    ·{' '}
                    {fill(c.until, {
                      date: dateIn(coupon.expiresAt, props.timeZone, props.locale),
                    })}
                  </Text>
                ) : null}
              </Text>
              {ask?.kind === 'cancel' && ask.id === coupon.id ? (
                <View style={{ gap: 8 }}>
                  <Text style={styles.value}>{fill(b.cancelAsk, { code: coupon.code })}</Text>
                  <View style={styles.row}>
                    <Button
                      label={b.cancelYes}
                      busy={busy}
                      onPress={() =>
                        void run(async () => {
                          await api.cancelLoyaltyCoupon(salon.orgId, coupon.id, coupon.version);
                          await reload();
                          return b.cancelled;
                        })
                      }
                    />
                    <Button kind="secondary" label={b.no} onPress={() => setAsk(null)} />
                  </View>
                </View>
              ) : (
                <View style={styles.row}>
                  <Button
                    kind="link"
                    label={b.cancelCoupon}
                    a11yLabel={fill(b.cancelOne, { code: coupon.code })}
                    disabled={busy}
                    onPress={() => {
                      setNote(null);
                      setAsk({ kind: 'cancel', id: coupon.id });
                    }}
                  />
                </View>
              )}
            </View>
          ))}
        </>
      ) : null}

      {enabled ? (
        <>
          <Text style={styles.label}>{b.redeemTitle}</Text>
          {stamps ? <Text style={styles.muted}>{b.redeemStampsHint}</Text> : null}
          {choices.length === 0 ? <Text style={styles.muted}>{b.noRewards}</Text> : null}
          {choices.map(({ reward, enough }) => (
            <View key={reward.id} style={styles.item}>
              <Text style={styles.value}>
                {reward.name}
                <Text style={styles.muted}> · {costText(reward.cost, account.mode, t)}</Text>
              </Text>
              {ask?.kind === 'redeem' && ask.id === reward.id ? (
                <View style={{ gap: 8 }}>
                  <Text style={styles.value}>
                    {fill(b.redeemAsk, {
                      cost: costText(reward.cost, account.mode, t),
                      name: reward.name,
                    })}
                  </Text>
                  <View style={styles.row}>
                    <Button
                      label={b.redeemYes}
                      busy={busy}
                      onPress={() =>
                        void run(async () => {
                          const coupon = await api.redeemLoyaltyReward(
                            salon.orgId,
                            customerId,
                            reward.id,
                          );
                          await reload();
                          return fill(b.redeemed, { code: coupon.code });
                        })
                      }
                    />
                    <Button kind="secondary" label={b.no} onPress={() => setAsk(null)} />
                  </View>
                </View>
              ) : (
                <View style={styles.row}>
                  <Button
                    kind="secondary"
                    label={b.redeem}
                    a11yLabel={fill(b.redeemOne, { name: reward.name })}
                    disabled={busy || !enough}
                    onPress={() => {
                      setNote(null);
                      setAsk({ kind: 'redeem', id: reward.id });
                    }}
                  />
                </View>
              )}
            </View>
          ))}
        </>
      ) : null}

      {adjust ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.label}>{b.adjustTitle}</Text>
          <TextInput
            accessibilityLabel={b.adjustPoints}
            placeholder={b.adjustPoints}
            placeholderTextColor={colors.placeholder}
            value={adjust.points}
            onChangeText={(points) => setAdjust({ ...adjust, points })}
            keyboardType="numbers-and-punctuation"
            style={styles.input}
          />
          <TextInput
            accessibilityLabel={b.adjustReason}
            placeholder={b.adjustReason}
            placeholderTextColor={colors.placeholder}
            value={adjust.reason}
            onChangeText={(reason) => setAdjust({ ...adjust, reason })}
            maxLength={500}
            style={styles.input}
          />
          <View style={styles.row}>
            <Button label={b.adjust} busy={busy} onPress={saveAdjust} />
            <Button kind="secondary" label={b.cancel} onPress={() => setAdjust(null)} />
          </View>
        </View>
      ) : (
        <View style={styles.row}>
          <Button
            kind="secondary"
            label={b.adjustOpen}
            onPress={() => {
              setNote(null);
              setAdjust({ points: '', reason: '' });
            }}
          />
        </View>
      )}

      {account.transactions.length > 0 ? (
        <>
          <Text style={styles.label}>{b.historyTitle}</Text>
          {account.transactions.slice(0, 10).map((entry) => (
            <View key={entry.id} style={styles.item}>
              <Text style={styles.value}>{t.loyalty.types[entry.type] ?? entry.type}</Text>
              <Text style={styles.muted}>
                {operationLine(entry, t, props.locale, props.timeZone)}
              </Text>
              {entry.note ? <Text style={styles.muted}>{entry.note}</Text> : null}
            </View>
          ))}
        </>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  label: { fontSize: 13, fontWeight: '700', color: colors.muted, marginTop: 8 },
  value: { fontSize: 16, color: colors.ink },
  muted: { color: colors.muted, fontSize: 14 },
  info: { color: '#2e7d32', fontSize: 15 },
  item: { gap: 4, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.line },
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
