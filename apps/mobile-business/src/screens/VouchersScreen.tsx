import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ScrollViewInstance,
} from 'react-native';
import type { BusinessApi, GiftVoucher, GiftVoucherDetails, GiftVoucherList, Locale } from '../api';
import { dayTitle, formatPrice } from '../day';
import { fill, type Dictionary } from '../i18n';
import { parseTip as parseAmount } from '../tip';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import {
  endsSoon,
  parseValidUntil,
  voucherErrorText,
  voucherLine,
  voucherCheckLink,
  voucherStatus,
  voucherText,
} from '../vouchers';
import { WEB_URL } from '../config';
import { bookingLink, shareCsv, shareText } from '../share';
import { csvTools, orderShareTools } from './csvTools';
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
  const manager = salon.role !== 'staff';
  const v = t.vouchers;
  const { voucher, uses } = details;
  const money = (n: number) => formatPrice(n, salon.currency, locale);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [editing, setEditing] = useState(false);
  const [editUntil, setEditUntil] = useState('');
  const [editRecipient, setEditRecipient] = useState('');
  const [editNote, setEditNote] = useState('');
  // Task 532: the payment the owner or a manager is asked about before undoing it.
  const [undoing, setUndoing] = useState<string | null>(null);
  // Task 539: while the salon page is public, "Wyślij bon" adds the link that shows what is left.
  const [checkUrl, setCheckUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api
      .location(salon.orgId, salon.locationId)
      .then((location) => {
        if (!live) return;
        setCheckUrl(
          location.onlineBookingEnabled
            ? voucherCheckLink(bookingLink(WEB_URL, location), voucher.code)
            : undefined,
        );
      })
      .catch(() => live && setCheckUrl(undefined));
    return () => {
      live = false;
    };
  }, [api, salon.orgId, salon.locationId, voucher.code]);

  async function undo(useId: string, amountGrosze: number) {
    setError('');
    setInfo('');
    setBusy(true);
    try {
      const next = await api.undoGiftVoucherUse(salon.orgId, salon.locationId, voucher.id, useId);
      props.onChange(next);
      setUndoing(null);
      setInfo(
        fill(v.undone, { amount: money(amountGrosze), left: money(next.voucher.balanceGrosze) }),
      );
    } catch (e) {
      setError(voucherErrorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    setError('');
    setInfo('');
    setEditUntil(voucher.validUntil ?? '');
    setEditRecipient(voucher.recipient ?? '');
    setEditNote(voucher.note ?? '');
    setEditing(true);
  }

  /** Task 500: "Zmień bon" — owners and managers; the amount stays (the server checks). */
  async function saveEdit() {
    setError('');
    setInfo('');
    const until = parseValidUntil(editUntil);
    if (until === undefined) return setError(v.wrongDate);
    setBusy(true);
    try {
      const updated = await api.updateGiftVoucher(salon.orgId, salon.locationId, voucher.id, {
        validUntil: until,
        recipient: editRecipient.trim() || null,
        note: editNote.trim() || null,
      });
      setEditing(false);
      props.onChange({ ...details, voucher: updated });
      setInfo(fill(v.edited, { code: updated.code }));
    } catch (e) {
      setError(voucherErrorText(e, t));
    } finally {
      setBusy(false);
    }
  }

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
          <Button
            kind="secondary"
            label={v.share}
            onPress={() => {
              setError('');
              setInfo('');
              const message = voucherText(
                voucher,
                salon.locationName,
                t,
                salon.currency,
                locale,
                checkUrl,
              );
              void shareText(
                { title: fill(v.shareTitle, { salon: salon.locationName }), message },
                orderShareTools(),
              ).then((result) => {
                if (result === 'copied') setInfo(v.shareCopied);
                if (result === 'failed') setError(v.shareFailed);
              });
            }}
          />
        </>
      ) : null}
      {manager && voucher.status !== 'cancelled' ? (
        editing ? (
          <View style={styles.confirm}>
            <Text style={styles.subheading}>{v.edit}</Text>
            <Text style={styles.muted}>{v.editHint}</Text>
            <Input label={v.validUntilField} value={editUntil} onChange={setEditUntil} />
            <Input label={v.recipient} value={editRecipient} onChange={setEditRecipient} />
            <Input label={v.note} value={editNote} onChange={setEditNote} />
            <View style={styles.buttons}>
              <Button label={v.editSave} busy={busy} onPress={() => void saveEdit()} />
              <Button kind="link" label={v.editCancel} onPress={() => setEditing(false)} />
            </View>
          </View>
        ) : (
          <Button kind="secondary" label={v.edit} onPress={startEdit} />
        )
      ) : null}
      <Text style={styles.subheading}>{v.uses}</Text>
      {uses.length === 0 ? (
        <Text style={styles.muted}>{v.noUses}</Text>
      ) : (
        uses.map((u) => (
          <View key={u.id} style={styles.use}>
            <Text style={[styles.muted, u.undoneDate ? styles.undone : null]}>
              {fill(v.useLine, {
                amount: money(u.amountGrosze),
                date: dayTitle(u.date, locale),
                time: u.time,
              })}
              {u.byName ? ` · ${u.byName}` : ''}
              {u.note ? ` · ${u.note}` : ''}
            </Text>
            {u.undoneDate ? (
              <Text style={styles.text}>
                {fill(v.undoneMark, { date: dayTitle(u.undoneDate, locale) })}
                {u.undoneByName ? ` · ${u.undoneByName}` : ''}
              </Text>
            ) : manager && voucher.status !== 'cancelled' ? (
              undoing === u.id ? (
                <View style={styles.confirm}>
                  <Text style={styles.text}>
                    {fill(v.undoAsk, { amount: money(u.amountGrosze) })}
                  </Text>
                  <View style={styles.buttons}>
                    <Button
                      kind="secondary"
                      label={v.undoYes}
                      busy={busy}
                      onPress={() => void undo(u.id, u.amountGrosze)}
                    />
                    <Button kind="link" label={v.undoNo} onPress={() => setUndoing(null)} />
                  </View>
                </View>
              ) : (
                <Button
                  kind="link"
                  label={v.undoUse}
                  a11yLabel={`${v.undoUse} ${money(u.amountGrosze)}`}
                  onPress={() => {
                    setInfo('');
                    setUndoing(u.id);
                  }}
                />
              )
            ) : null}
          </View>
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
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvInfo, setCsvInfo] = useState('');
  const scroll = useRef<ScrollViewInstance>(null);

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

  /**
   * Task 495: "CSV bonów" — shared or saved like the other CSV files of the app; task 535: "CSV
   * płatności bonami" the same way.
   */
  async function downloadCsv(uses = false) {
    if (csvBusy) return;
    setCsvBusy(true);
    setCsvInfo('');
    try {
      const file = uses
        ? await api.giftVoucherUsesCsv(salon.orgId, salon.locationId, locale)
        : await api.giftVouchersCsv(salon.orgId, salon.locationId, locale);
      const result = await shareCsv(file, csvTools());
      setCsvInfo(result === 'failed' ? v.csvFailed : '');
    } catch (e) {
      setCsvInfo(voucherErrorText(e, t));
    } finally {
      setCsvBusy(false);
    }
  }

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

  /** Task 503: "Pokaż" — the voucher's card from the list, without typing the code. */
  async function show(voucher: GiftVoucher) {
    setCheckError('');
    try {
      setFound(await api.giftVoucher(salon.orgId, salon.locationId, voucher.id));
      setCode(voucher.code);
      scroll.current?.scrollTo({ y: 0, animated: true });
    } catch (e) {
      setListError(voucherErrorText(e, t));
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
    <ScrollView
      ref={scroll}
      contentContainerStyle={styles.screen}
      keyboardShouldPersistTaps="handled"
    >
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
              {list.expiringSoon.count > 0 ? (
                <Text style={styles.warn}>
                  {fill(v.expiringTotal, {
                    count: String(list.expiringSoon.count),
                    amount: money(list.expiringSoon.balanceGrosze),
                  })}
                </Text>
              ) : null}
              <Button
                kind="secondary"
                label={csvBusy ? t.loading : v.csv}
                onPress={() => void downloadCsv()}
              />
              <Button
                kind="secondary"
                label={csvBusy ? t.loading : v.usesCsv}
                onPress={() => void downloadCsv(true)}
              />
              {csvInfo ? <Text style={styles.muted}>{csvInfo}</Text> : null}
              <Card>
                {list.vouchers.map((x, i) => (
                  <View key={x.id} style={[styles.row, i > 0 && styles.divider]}>
                    <Text style={styles.code}>
                      {x.code} · {voucherStatus(x, t)}
                    </Text>
                    <Text style={styles.text}>{voucherLine(x, t, salon.currency, locale)}</Text>
                    {endsSoon(x, list.expiringSoon.until) ? (
                      <Text style={styles.warn}>{v.expiringMark}</Text>
                    ) : null}
                    <Text style={styles.muted}>
                      {fill(v.soldOn, { date: dayTitle(x.soldDate, locale) })}
                      {x.recipient ? ` · ${fill(v.forWhom, { name: x.recipient })}` : ''}
                    </Text>
                    <Button
                      kind="link"
                      label={v.show}
                      a11yLabel={`${v.show} ${x.code}`}
                      onPress={() => void show(x)}
                    />
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
  warn: { color: colors.danger, fontSize: 14, fontWeight: '600' },
  row: { paddingVertical: 10, gap: 4 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  confirm: { gap: 6 },
  use: { gap: 2 },
  undone: { textDecorationLine: 'line-through' },
  buttons: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
});
