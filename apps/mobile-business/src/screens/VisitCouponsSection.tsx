import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { AppointmentDetail, BusinessApi, Locale, VisitCoupons } from '../api';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { couponCode, couponErrorText, hasCoupons } from '../visitCoupons';
import { Button, Card, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 343: "Kupony i rabat klienta" in the visit card — the client's tier discount, the coupons
 * used (with "Zdejmij") and the other unused ones with what each takes off or why it cannot be
 * used, plus a field for the code the client shows. Reloaded whenever the visit changes.
 */
export function VisitCouponsSection(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  visit: AppointmentDetail;
  onVisit: (visit: AppointmentDetail) => void;
}) {
  const { api, t, salon, visit } = props;
  const c = t.visit.coupons;
  const [coupons, setCoupons] = useState<VisitCoupons | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    api.visitCoupons(salon.orgId, salon.locationId, visit.id).then(
      (data) => alive && setCoupons(data),
      // Without the list the visit still works; coupons simply are not offered.
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, salon, visit.id, visit.version]);

  const money = (grosze: number) => formatPrice(grosze, salon.currency, props.locale);

  async function run(action: () => Promise<AppointmentDetail>, done: string) {
    setBusy(true);
    setNote(null);
    try {
      props.onVisit(await action());
      setNote({ text: done, bad: false });
      setCode('');
    } catch (e) {
      setNote({ text: couponErrorText(e, t) ?? errorText(e, t), bad: true });
    } finally {
      setBusy(false);
    }
  }

  const typed = couponCode(code);
  // Nothing to offer (no tier, no coupons): the card stays away from every visit.
  if (!coupons || (!hasCoupons(coupons) && !note)) return null;
  const tier = coupons.tier;
  const at = [salon.orgId, salon.locationId, visit.id, visit.version] as const;

  return (
    <Card>
      <Text style={styles.label} role="heading">
        {c.title}
      </Text>
      <Text style={styles.muted}>{c.hint}</Text>

      {tier ? (
        <View style={styles.item}>
          <Text style={styles.value}>
            {tier.applied ? '✓ ' : ''}
            {fill(c.tier, { name: tier.name, percent: String(tier.discountPercent) })}
            {tier.discountGrosze !== null
              ? ` · ${fill(c.off, { amount: money(tier.discountGrosze) })}`
              : ''}
          </Text>
          {tier.problem && !tier.applied ? (
            <Text style={styles.muted}>{c.problem[tier.problem]}</Text>
          ) : null}
          {tier.applied ? (
            <View style={styles.row}>
              <Button
                kind="secondary"
                label={c.removeTier}
                busy={busy}
                onPress={() => void run(() => api.setTierDiscount(...at, false), c.removed)}
              />
            </View>
          ) : tier.problem ? null : (
            <View style={styles.row}>
              <Button
                label={c.useTier}
                busy={busy}
                onPress={() => void run(() => api.setTierDiscount(...at, true), c.applied)}
              />
            </View>
          )}
        </View>
      ) : null}

      {coupons.applied.map((coupon) => (
        <View key={coupon.id} style={styles.item}>
          <Text style={styles.value}>
            {fill(c.used, { name: coupon.name })} <Text style={styles.muted}>{coupon.code}</Text>
            {coupon.discountGrosze !== null
              ? ` · ${fill(c.off, { amount: money(coupon.discountGrosze) })}`
              : ''}
          </Text>
          <View style={styles.row}>
            <Button
              kind="secondary"
              label={c.remove}
              a11yLabel={fill(c.removeOne, { code: coupon.code })}
              busy={busy}
              onPress={() => void run(() => api.removeVisitCoupon(...at, coupon.id), c.removed)}
            />
          </View>
        </View>
      ))}

      {coupons.available.map((coupon) => (
        <View key={coupon.id} style={styles.item}>
          <Text style={styles.value}>
            {coupon.name} <Text style={styles.muted}>{coupon.code}</Text>
            {coupon.problem ? (
              <Text style={styles.muted}> · {c.problem[coupon.problem]}</Text>
            ) : null}
          </Text>
          {coupon.problem ? null : (
            <View style={styles.row}>
              <Button
                label={
                  coupon.discountGrosze !== null
                    ? `${c.use} ${fill(c.off, { amount: money(coupon.discountGrosze) })}`
                    : c.use
                }
                a11yLabel={fill(c.useOne, { code: coupon.code })}
                busy={busy}
                onPress={() =>
                  void run(() => api.applyVisitCoupon(...at, { couponId: coupon.id }), c.applied)
                }
              />
            </View>
          )}
        </View>
      ))}

      <View style={styles.row}>
        <TextInput
          accessibilityLabel={c.code}
          placeholder={c.code}
          placeholderTextColor={colors.placeholder}
          autoCapitalize="characters"
          autoCorrect={false}
          value={code}
          onChangeText={setCode}
          maxLength={24}
          style={[styles.input, { flex: 1, minWidth: 160 }]}
        />
        <Button
          kind="secondary"
          label={c.useCode}
          busy={busy}
          disabled={typed === null}
          onPress={() => {
            if (typed) void run(() => api.applyVisitCoupon(...at, { code: typed }), c.applied);
          }}
        />
      </View>

      {note ? (
        note.bad ? (
          <ErrorText>{note.text}</ErrorText>
        ) : (
          <Text role="status" style={styles.info}>
            {note.text}
          </Text>
        )
      ) : null}

      {visit.priceGrosze !== null && visit.discountGrosze ? (
        <Text style={styles.total}>
          {fill(c.toPay, { amount: money(Math.max(0, visit.priceGrosze - visit.discountGrosze)) })}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  label: { fontSize: 13, fontWeight: '700', color: colors.muted },
  value: { fontSize: 16, color: colors.ink },
  total: { fontSize: 17, fontWeight: '700', color: colors.ink, marginTop: 6 },
  muted: { color: colors.muted, fontSize: 14 },
  info: { color: '#2e7d32', fontSize: 15 },
  item: { gap: 6, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.line },
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
