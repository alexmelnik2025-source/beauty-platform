import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ClientApi, Locale, VisitProducts } from '../api';
import type { BookingPreset } from '../booking';
import { formatPrice } from '../format';
import type { Dictionary } from '../i18n';
import { Button, colors } from '../ui';

/**
 * Task Q3 in the app: "Przenieść produkty na nowy termin?" — the visit was cancelled while
 * products waited for it at the salon. One button opens the booking with the same service and
 * specialist and the products come along (put aside right after booking), like on the visit page
 * by link. An empty visit keeps its regular rebooking action.
 */
export function MoveProductsCard(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  visitId: string;
  serviceId: string;
  staffId: string | null;
  /** Told when the card appears, so the screen keeps one main button. */
  onShown?: (shown: boolean) => void;
  onBook: (preset: BookingPreset) => void;
}) {
  const { api, t, locale, visitId } = props;
  const s = t.visitProducts;
  const [data, setData] = useState<VisitProducts | null>(null);

  useEffect(() => {
    api
      .visitProducts(visitId)
      .then(setData)
      .catch(() => setData(null));
  }, [api, visitId]);

  const waiting = (data?.reservations ?? []).filter(
    (r) => r.status === 'reserved' && r.productId !== null,
  );
  const shown = !!data && waiting.length > 0;
  const { onShown } = props;
  useEffect(() => {
    onShown?.(shown);
  }, [onShown, shown]);
  if (!data) return null;
  if (!shown) {
    return (
      <Text role="status" aria-live="polite" style={styles.muted}>
        {`${s.title}: 0`}
      </Text>
    );
  }
  const productIds = Array.from(new Set(waiting.map((r) => r.productId as string)));

  return (
    <View role="region" aria-label={s.moveTitle} style={styles.card} testID="move-products">
      <Text role="heading" aria-level={2} style={styles.title}>
        {s.moveTitle}
      </Text>
      {waiting.map((r) => (
        <View key={r.id} accessible style={styles.row}>
          <Text style={styles.name}>{r.quantity > 1 ? `${r.name} × ${r.quantity}` : r.name}</Text>
          <Text style={styles.price}>{formatPrice(r.totalGrosze, data.currency, locale)}</Text>
        </View>
      ))}
      <Text style={styles.muted}>{s.moveLead}</Text>
      <Button
        label={s.moveBook}
        onPress={() =>
          props.onBook({ serviceId: props.serviceId, staffId: props.staffId, productIds })
        }
      />
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
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 },
  name: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.ink },
  price: { maxWidth: '100%', fontSize: 15, color: colors.ink },
  muted: { color: colors.muted, fontSize: 14 },
});
