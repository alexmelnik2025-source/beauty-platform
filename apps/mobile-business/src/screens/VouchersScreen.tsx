import { useCallback, useEffect, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, GiftVoucher, GiftVoucherDetails, GiftVoucherList, Locale } from '../api';
import { dayTitle, formatPrice } from '../day';
import { fill, type Dictionary } from '../i18n';
import { parseTip as parseAmount } from '../tip';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import { parseValidUntil, voucherErrorText, voucherLine, voucherStatus } from '../vouchers';
import type { SalonChoice } from './SalonsScreen';

function Input(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  numeric?: boolean;
  caps?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        keyboardType={props.numeric ? 'decimal-pad' : 'default'}
        autoCapitalize={props.caps ? 'characters' : 'sentences'}
        autoCorrect={false}
        style={styles.input}
      />
    </View>
  );
}

/** One voucher: code, status, what is left; "Zapłać bonem" while it may be used; its payments. */
function VoucherCard(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  details: GiftVoucherDetails;
  onChange: (next: GiftVoucherDetails) => void;
}) {
  const { api, t, locale, salon, details } = props;
  const v = t.vouchers;
  const { voucher, uses } = details;
  const money = (n: number) => formatPrice(n, salon.currency, locale);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  async function pay() {
    setError('');
    setInfo('');
    const grosze = parseAmount(amount);
    if (!grosze) return setError(v.wrongAmount);
    setBusy(true);
    try {
      const next = await api.redeemGiftVoucher(
        salon.orgId,
        salon.locationId,
        voucher.id,
        grosze,
        note,
      );
      props.onChange(next);
      setAmount('');
      setNote('');
      setInfo(fill(v.paid, { amount: money(grosze), left: money(next.voucher.balanceGrosze) }));
    } catch (e) {
      setError(voucherErrorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Text style={styles.code}>
        {voucher.code} · {voucherStatus(voucher, t)}
      </Text>
      <Text style={styles.text}>{voucherLine(voucher, t, salon.currency, locale)}</Text>
      {voucher.recipient ? (
        <Text style={styles.text}>{fill(v.forWhom, { name: voucher.recipient })}</Text>
      ) : null}
      {voucher.note ? <Text style={styles.muted}>{voucher.note}</Text> : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {info ? (
        <Text role="status" style={styles.info}>
          {info}
        </Text>
      ) : null}
      {voucher.status === 'active' ? (
        <>
          <Input label={v.payAmount} value={amount} onChange={setAmount} numeric />
          <Input label={v.payNote} value={note} onChange={setNote} />
          <Button label={v.pay} busy={busy} onPress={() => void pay()} />
        </>
      ) : null}
      <Text style={styles.subheading}>{v.uses}</Text>
      {uses.length === 0 ? (
        <Text style={styles.muted}>{v.noUses}</Text>
      ) : (
        uses.map((u) => (
          <Text key={u.id} style={styles.muted}>
            {fill(v.useLine, {
              amount: money(u.amountGrosze),
              date: dayTitle(u.date, locale),
              time: u.time,
            })}
            {u.byName ? ` · ${u.byName}` : ''}
            {u.note ? ` · ${u.note}` : ''}
          </Text>
        ))
      )}
    </Card>
  );
}

/**
 * Task 492: "Bony podarunkowe" in the business app, as in the cabinet (491). Everyone in the salon
 * checks a voucher by the code the client shows and takes a payment with it; owners and managers
 * also sell vouchers, see the ones sold and cancel one sold by mistake (the server checks).
 */
export function VouchersScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  onBack: () => void;
}) {
  const { api, t, locale, salon, onBack } = props;
  const v = t.vouchers;
  const manager = salon.role !== 'staff';
  const money = (n: number) => formatPrice(n, salon.currency, locale);
  const [code, setCode] = useState('');
  const [found, setFound] = useState<GiftVoucherDetails | null>(null);
  const [checkError, setCheckError] = useState('');
  const [checking, setChecking] = useState(false);
  const [list, setList] = useState<GiftVoucherList | null>(null);
  const [listError, setListError] = useState('');
  const [amount, setAmount] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [recipient, setRecipient] = useState('');
  const [note, setNote] = useState('');
  const [sellError, setSellError] = useState('');
  const [sold, setSold] = useState<GiftVoucher | null>(null);
  const [selling, setSelling] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [info, setInfo] = useState('');

  const load = useCallback(async () => {
    if (!manager) return;
    try {
      setList(await api.giftVouchers(salon.orgId, salon.locationId));
      setListError('');
    } catch (e) {
      setListError(voucherErrorText(e, t));
    }
  }, [api, manager, salon, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Android's back button closes the screen instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  async function check() {
    if (!code.trim()) return;
    setCheckError('');
    setFound(null);
    setChecking(true);
    try {
      setFound(await api.giftVoucherByCode(salon.orgId, salon.locationId, code));
    } catch (e) {
      setCheckError(voucherErrorText(e, t));
    } finally {
      setChecking(false);
    }
  }

  async function sell() {
    setSellError('');
    setSold(null);
    const grosze = parseAmount(amount);
    if (!grosze || grosze < 100) return setSellError(v.wrongAmount);
    const until = parseValidUntil(validUntil);
    if (until === undefined) return setSellError(v.wrongDate);
    setSelling(true);
    try {
      const voucher = await api.sellGiftVoucher(salon.orgId, salon.locationId, {
        amountGrosze: grosze,
        validUntil: until,
        recipient: recipient.trim() || null,
        note: note.trim() || null,
      });
      setSold(voucher);
      setAmount('');
      setValidUntil('');
      setRecipient('');
      setNote('');
      await load();
    } catch (e) {
      setSellError(voucherErrorText(e, t));
    } finally {
      setSelling(false);
    }
  }

  async function cancel(voucher: GiftVoucher) {
    setInfo('');
    try {
      await api.cancelGiftVoucher(salon.orgId, salon.locationId, voucher.id);
      setInfo(fill(v.cancelled, { code: voucher.code }));
      setConfirm(null);
      await load();
    } catch (e) {
      setListError(voucherErrorText(e, t));
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Button kind="link" label={v.back} onPress={onBack} />
      <Heading>{v.title}</Heading>
      <Text style={styles.muted}>{v.hint}</Text>

      <Text role="heading" aria-level={2} style={styles.subheading}>
        {v.checkTitle}
      </Text>
      <Input label={v.code} value={code} onChange={setCode} caps />
      <Button kind="secondary" label={v.check} busy={checking} onPress={() => void check()} />
      {checkError ? <ErrorText>{checkError}</ErrorText> : null}
      {found ? (
        <VoucherCard
          api={api}
          t={t}
          locale={locale}
          salon={salon}
          details={found}
          onChange={(next) => {
            setFound(next);
            void load();
          }}
        />
      ) : null}

      {manager ? (
        <>
          <Text role="heading" aria-level={2} style={styles.subheading}>
            {v.newTitle}
          </Text>
          <Input label={v.amount} value={amount} onChange={setAmount} numeric />
          <Input label={v.validUntilField} value={validUntil} onChange={setValidUntil} />
          <Input label={v.recipient} value={recipient} onChange={setRecipient} />
          <Input label={v.note} value={note} onChange={setNote} />
          {sellError ? <ErrorText>{sellError}</ErrorText> : null}
          <Button label={v.sell} busy={selling} onPress={() => void sell()} />
          {sold ? (
            <Text role="status" style={styles.info}>
              {fill(v.sold, { code: sold.code })}
            </Text>
          ) : null}

          <Text role="heading" aria-level={2} style={styles.subheading}>
            {v.listTitle}
          </Text>
          {listError ? <ErrorText>{listError}</ErrorText> : null}
          {info ? (
            <Text role="status" style={styles.info}>
              {info}
            </Text>
          ) : null}
          {list === null ? (
            listError ? null : (
              <Text style={styles.muted}>{t.loading}</Text>
            )
          ) : list.vouchers.length === 0 ? (
            <Text style={styles.muted}>{v.empty}</Text>
          ) : (
            <>
              <Text style={styles.text}>
                {fill(v.activeTotal, { amount: money(list.activeBalanceGrosze) })}
              </Text>
              <Card>
                {list.vouchers.map((x, i) => (
                  <View key={x.id} style={[styles.row, i > 0 && styles.divider]}>
                    <Text style={styles.code}>
                      {x.code} · {voucherStatus(x, t)}
                    </Text>
                    <Text style={styles.text}>{voucherLine(x, t, salon.currency, locale)}</Text>
                    <Text style={styles.muted}>
                      {fill(v.soldOn, { date: dayTitle(x.soldDate, locale) })}
                      {x.recipient ? ` · ${fill(v.forWhom, { name: x.recipient })}` : ''}
                    </Text>
                    {x.status === 'active' ? (
                      confirm === x.id ? (
                        <View style={styles.confirm}>
                          <Text style={styles.text}>{fill(v.cancelAsk, { code: x.code })}</Text>
                          <View style={styles.buttons}>
                            <Button
                              kind="secondary"
                              label={v.cancelYes}
                              onPress={() => void cancel(x)}
                            />
                            <Button
                              kind="link"
                              label={v.cancelNo}
                              onPress={() => setConfirm(null)}
                            />
                          </View>
                        </View>
                      ) : (
                        <Button
                          kind="link"
                          label={v.cancel}
                          a11yLabel={`${v.cancel} ${x.code}`}
                          onPress={() => {
                            setInfo('');
                            setConfirm(x.id);
                          }}
                        />
                      )
                    ) : null}
                  </View>
                ))}
              </Card>
            </>
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  field: { gap: 4 },
  label: { color: colors.muted, fontSize: 14 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    backgroundColor: colors.card,
    color: colors.ink,
  },
  subheading: { fontSize: 18, fontWeight: '700', color: colors.ink, marginTop: 8 },
  code: { fontSize: 16, fontWeight: '700', color: colors.ink, letterSpacing: 1 },
  text: { color: colors.ink, fontSize: 15 },
  muted: { color: colors.muted, fontSize: 14 },
  info: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  row: { paddingVertical: 10, gap: 4 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  confirm: { gap: 6 },
  buttons: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
});
