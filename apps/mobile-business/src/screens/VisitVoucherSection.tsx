import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type BusinessApi, type Locale, type VisitVoucherPayments } from '../api';
import { formatPrice } from '../day';
import { fill, type Dictionary } from '../i18n';
import { parseTip as parseAmount } from '../tip';
import { Button, colors, ErrorText } from '../ui';
import { printedCode, visitVoucherAmount, visitVoucherLeft, voucherErrorText } from '../vouchers';
import type { SalonChoice } from './SalonsScreen';

interface Props {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  appointmentId: string;
  /** The visit price after discounts; null when the price is hidden. */
  toPayGrosze: number | null;
  serviceName: string;
}

/**
 * Task 542: "Zapłać bonem" in the card of a visit that took place — the same as in the cabinet
 * (task 541): the code from the voucher and the amount (what is left to pay for the visit is
 * filled in); the payment belongs to the visit and is listed here. Everyone who sees the visit.
 */
export function VisitVoucherSection(props: Props) {
  const key = JSON.stringify([props.salon.orgId, props.salon.locationId, props.appointmentId]);
  return <VoucherPayments key={key} {...props} />;
}

function VoucherPayments(props: Props) {
  const { api, t, salon, appointmentId } = props;
  const v = t.vouchers;
  const [payments, setPayments] = useState<VisitVoucherPayments | null>(null);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const money = (hundredths: number) => formatPrice(hundredths, salon.currency, props.locale);

  const { orgId, locationId } = salon;
  const scope = useRef<AbortController | null>(null);
  const [loadFailure, setLoadFailure] = useState<{ cause: unknown } | null>(null);
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const data = await api.visitVoucherPayments(orgId, locationId, appointmentId);
        if (signal.aborted) return;
        setPayments(data);
        setLoadFailure(null);
      } catch (cause) {
        if (!signal.aborted) setLoadFailure({ cause });
      }
    },
    [api, orgId, locationId, appointmentId],
  );

  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const pay = async () => {
    const signal = scope.current?.signal;
    if (!signal || signal.aborted || busy) return;
    setLoadFailure(null);
    setError('');
    setInfo('');
    const wanted = code.trim().toUpperCase().replace(/[\s-]/g, '');
    if (wanted.length < 4) return setError(v.notFound);
    const grosze = parseAmount(amount);
    if (!grosze) return setError(v.wrongAmount);
    setBusy(true);
    try {
      const found = await api.giftVoucherByCode(salon.orgId, salon.locationId, wanted);
      if (signal.aborted) return;
      const next = await api.redeemGiftVoucher(
        salon.orgId,
        salon.locationId,
        found.voucher.id,
        grosze,
        props.serviceName,
        appointmentId,
      );
      if (signal.aborted) return;
      setInfo(fill(v.paid, { amount: money(grosze), left: money(next.voucher.balanceGrosze) }));
      setCode('');
      setOpen(false);
      await load(signal);
    } catch (e) {
      if (!signal.aborted)
        setError(e instanceof ApiError && e.status === 404 ? v.notFound : voucherErrorText(e, t));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };

  const message = error || (loadFailure ? voucherErrorText(loadFailure.cause, t) : '');
  if (!payments) return message ? <ErrorText>{message}</ErrorText> : null;
  const left = visitVoucherLeft(props.toPayGrosze, payments.totalGrosze);

  return (
    <View style={{ gap: 6 }} testID="visit-vouchers">
      <PaymentHistory
        payments={payments}
        left={left}
        v={v}
        currency={salon.currency}
        locale={props.locale}
      />
      {info ? <Text style={styles.info}>{info}</Text> : null}
      {open ? (
        <View style={{ gap: 8 }}>
          <TextInput
            accessibilityLabel={v.code}
            placeholder="ABCD-EFGH"
            placeholderTextColor={colors.placeholder}
            value={code}
            maxLength={20}
            autoCapitalize="characters"
            autoCorrect={false}
            onChangeText={setCode}
            style={styles.input}
            testID="visit-voucher-code"
          />
          <TextInput
            accessibilityLabel={v.payAmount}
            placeholder={v.payAmount}
            placeholderTextColor={colors.placeholder}
            value={amount}
            keyboardType="decimal-pad"
            onChangeText={setAmount}
            style={styles.input}
            testID="visit-voucher-amount"
          />
          <View style={styles.row}>
            <Button label={v.pay} busy={busy} disabled={!code.trim()} onPress={() => void pay()} />
            <Button
              kind="link"
              label={t.clients.cancel}
              onPress={() => {
                setOpen(false);
                setError('');
              }}
            />
          </View>
        </View>
      ) : (
        <Button
          kind="link"
          label={v.visitOpen}
          onPress={() => {
            setOpen(true);
            setInfo('');
            setAmount(visitVoucherAmount(props.toPayGrosze, payments.totalGrosze));
          }}
        />
      )}
      {message ? <ErrorText>{message}</ErrorText> : null}
    </View>
  );
}

const PaymentHistory = memo(function PaymentHistory({
  payments,
  left,
  v,
  currency,
  locale,
}: {
  payments: VisitVoucherPayments;
  left: number | null;
  v: Dictionary['vouchers'];
  currency: string;
  locale: Locale;
}) {
  if (!payments.payments.length) return null;
  const money = (hundredths: number) => formatPrice(hundredths, currency, locale);
  return (
    <>
      <Text style={styles.label}>{fill(v.visitPaid, { amount: money(payments.totalGrosze) })}</Text>
      {left === null ? null : (
        <Text style={styles.label} testID="visit-voucher-left">
          {left > 0 ? fill(v.visitLeft, { amount: money(left) }) : v.visitCovered}
        </Text>
      )}
      {payments.payments.map((p) => (
        <View key={p.id} style={styles.row}>
          <Text style={[styles.name, p.undoneDate ? styles.undone : null]}>
            {printedCode(p.code)}
            <Text style={styles.muted}>
              {` · ${p.time}${p.byName ? ` · ${p.byName}` : ''}`}
              {p.undoneDate ? ` · ${fill(v.undoneMark, { date: p.undoneDate })}` : ''}
            </Text>
          </Text>
          <Text style={[styles.muted, p.undoneDate ? styles.undone : null]}>
            {money(p.amountGrosze)}
          </Text>
        </View>
      ))}
    </>
  );
});

const styles = StyleSheet.create({
  label: { marginTop: 8, fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
  name: { fontSize: 16, color: colors.ink, flexShrink: 1, flexGrow: 1 },
  muted: { color: colors.muted, fontSize: 14 },
  undone: { textDecorationLine: 'line-through', opacity: 0.6 },
  info: { color: colors.ink, fontSize: 14 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink,
  },
});
