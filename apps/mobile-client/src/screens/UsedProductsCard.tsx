import { useCallback, useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { ClientApi, Locale, UsedProducts } from '../api';
import type { BookingPreset } from '../booking';
import { API_URL } from '../config';
import { errorText } from '../errors';
import { formatDay, formatPrice } from '../format';
import { fill, type Dictionary } from '../i18n';
import { Button, colors, ErrorText } from '../ui';

/**
 * Task Q3 (screen C in the app): in the card of a visit that took place — what the specialist
 * used ("Na wizycie użyto"). With my next visit in that salon booked: "Odłóż na następną wizytę"
 * on each. Without one: "Umów kolejną wizytę" opens the booking with the same specialist and the
 * products come along (put aside right after booking). Nothing when nothing was used.
 */
export function UsedProductsCard(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  visitId: string;
  onBookNext: (preset: BookingPreset) => void;
}) {
  const { api, t, locale, visitId } = props;
  const s = t.visitProducts;
  const [data, setData] = useState<UsedProducts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    () =>
      api
        .usedProducts(visitId)
        .then(setData)
        .catch(() => setData(null)),
    [api, visitId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function save(productId: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setData(await api.reserveForNext(visitId, productId));
    } catch (e) {
      setError(errorText(e, t));
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!data || data.products.length === 0) return null;
  const next = data.nextVisit;
  const when = next ? `${next.time} · ${formatDay(next.date, locale)}` : '';
  const toBring = data.products.filter((p) => p.available).map((p) => p.id);
  const photo = (id: string) => ({ uri: `${API_URL}/v1/public/photos/${id}` });

  return (
    <View role="region" aria-label={s.usedTitle} style={styles.card} testID="used-products">
      <Text role="heading" aria-level={2} style={styles.title}>
        {s.usedTitle}
      </Text>
      {data.products.map((p) => (
        <View key={p.id} style={styles.item}>
          <View style={styles.row}>
            {p.photoId ? (
              <Image
                accessible
                accessibilityLabel={p.name}
                source={photo(p.photoId)}
                style={styles.photo}
              />
            ) : null}
            <View style={styles.grow}>
              <Text style={styles.name}>
                {p.name}
                {p.brand ? <Text style={styles.muted}> · {p.brand}</Text> : null}
              </Text>
              <Text style={styles.muted}>
                {formatPrice(p.priceGrosze, data.currency, locale)}
                {!p.available && !p.reservedForNext ? ` · ${s.unavailable}` : ''}
              </Text>
            </View>
          </View>
          {next && p.reservedForNext ? (
            <Text role="status" style={styles.saved}>
              ✓ {fill(s.savedForNext, { when })}
            </Text>
          ) : next ? (
            <Button
              kind="secondary"
              label={s.saveForNext}
              a11yLabel={`${s.saveForNext}: ${p.name}`}
              disabled={busy || !p.available}
              onPress={() => void save(p.id)}
            />
          ) : null}
        </View>
      ))}
      <Text style={styles.muted}>{s.payAtPickup}</Text>
      {next ? null : (
        <>
          <Text style={styles.muted}>
            {s.noNext}
            {toBring.length ? ` ${s.bookNextHint}` : ''}
          </Text>
          <Button
            label={s.bookNext}
            onPress={() =>
              props.onBookNext({
                serviceId: data.rebook.serviceId,
                staffId: data.rebook.staffId,
                ...(toBring.length ? { productIds: toBring } : {}),
              })
            }
          />
        </>
      )}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 16,
    gap: 12,
  },
  title: { fontSize: 18, fontWeight: '700', color: colors.ink },
  item: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flex: 1, minWidth: 0, gap: 2 },
  photo: { width: 56, height: 56, borderRadius: 10 },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  saved: { fontSize: 15, fontWeight: '600', color: colors.ink },
});
