import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type ClientApi, type Locale, type PublicGiftVoucher } from '../api';
import { errorText } from '../errors';
import { formatPrice, LOCALE_TAGS } from '../format';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText } from '../ui';

/** "17 lutego 2027": a voucher may be valid into the next year, so the year is shown. */
function dayWithYear(date: string, tag: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(tag, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Task 538: "Sprawdź bon" on the salon screen — a client with a gift voucher of this salon types
 * its code and sees what is left and until when (the same as on the salon page, task 537). Only
 * the value and the dates: who it is for and the payments stay in the salon.
 */
export function VoucherCheck(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  slug: string;
}) {
  const { api, t, locale, slug } = props;
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [voucher, setVoucher] = useState<PublicGiftVoucher | null>(null);

  async function check() {
    if (code.trim().length < 4 || busy) return;
    setBusy(true);
    setError('');
    setVoucher(null);
    try {
      setVoucher(await api.voucherBalance(slug, code));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404 ? t.voucherCheck.notFound : errorText(err, t),
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <Button kind="secondary" label={t.voucherCheck.open} onPress={() => setOpen(true)} />;
  }

  const status = voucher
    ? {
        active: t.voucherCheck.statusActive,
        used: t.voucherCheck.statusUsed,
        expired: t.voucherCheck.statusExpired,
        cancelled: t.voucherCheck.statusCancelled,
      }[voucher.status]
    : '';
  const money = (value: number) => formatPrice(value, voucher?.currency ?? 'PLN', locale);

  return (
    <Card>
      <Text role="heading" aria-level={2} style={styles.section}>
        {t.voucherCheck.title}
      </Text>
      <Text style={styles.small}>{t.voucherCheck.hint}</Text>
      <TextInput
        accessibilityLabel={t.voucherCheck.code}
        placeholder="ABCD-EFGH"
        placeholderTextColor={colors.placeholder}
        value={code}
        onChangeText={setCode}
        onSubmitEditing={() => void check()}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={20}
        style={styles.input}
      />
      <Button
        label={t.voucherCheck.check}
        onPress={() => void check()}
        busy={busy}
        disabled={code.trim().length < 4}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      {voucher ? (
        <View role="status" style={styles.result}>
          <Text style={styles.strong}>
            {fill(t.voucherCheck.left, {
              left: money(voucher.balanceGrosze),
              amount: money(voucher.amountGrosze),
            })}
          </Text>
          <Text style={styles.body}>
            {status}
            {' · '}
            {voucher.validUntil
              ? fill(t.voucherCheck.validUntil, {
                  date: dayWithYear(voucher.validUntil, LOCALE_TAGS[locale]),
                })
              : t.voucherCheck.noEnd}
          </Text>
          {voucher.status === 'active' ? (
            <Text style={styles.small}>{t.voucherCheck.payAtSalon}</Text>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  section: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  small: { color: colors.muted, fontSize: 14, marginVertical: 6 },
  body: { color: colors.ink, fontSize: 15 },
  strong: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  result: { gap: 4, marginTop: 10 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 17,
    color: colors.ink,
    letterSpacing: 2,
    marginBottom: 8,
  },
});
