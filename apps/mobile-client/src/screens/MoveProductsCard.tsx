import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { ClientApi, Locale, VisitProducts } from '../api';
import type { BookingPreset } from '../booking';
import { errorText } from '../errors';
import { formatPrice } from '../format';
import type { Dictionary } from '../i18n';
import { visitProductLists } from '../shop';
import { Button, colors, ErrorText } from '../ui';
import { withNetworkTimeout } from '../withNetworkTimeout';

function canMove(reservation: VisitProducts['reservations'][number]) {
  return reservation.status === 'reserved' && reservation.productId !== null;
}

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
  /** Offer ordinary rebooking only after the list confirms there is nothing to transfer. */
  emptyAction: ReactNode;
  onBook: (preset: BookingPreset) => void;
}) {
  const { api, t, locale, visitId } = props;
  const s = t.visitProducts;
  const [data, setData] = useState<VisitProducts | null>(null);

  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    let reading = false;
    visitProductLists
      .read(api, visitId, () => {
        reading = true;
        return withNetworkTimeout(api.visitProducts(visitId));
      })
      .then(
        (result) => {
          reading = false;
          if (live) {
            // A newly reserved product must appear on return to an initially empty visit.
            if (!result.reservations.some(canMove)) visitProductLists.clear(api, visitId);
            setData(result);
            setFailure(null);
          }
        },
        (cause: unknown) => {
          reading = false;
          if (live) setFailure({ cause });
        },
      );
    return () => {
      live = false;
      if (reading) visitProductLists.clear(api, visitId);
    };
  }, [api, visitId, attempt]);

  const waiting = data?.reservations.filter(canMove) ?? [];
  const feedback = failure ? (
    <View>
      <ErrorText>{errorText(failure.cause, t)}</ErrorText>
      <Button
        kind="secondary"
        label={t.retry}
        onPress={() => {
          setFailure(null);
          setAttempt((n) => n + 1);
        }}
      />
    </View>
  ) : null;
  if (!data)
    return (
      feedback ?? (
        <ActivityIndicator
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={s.title}
          color={colors.ink}
        />
      )
    );
  if (!waiting.length) {
    return (
      <>
        {feedback}
        <Text role="status" aria-live="polite" style={styles.muted}>
          {`${s.title}: 0`}
        </Text>
        {props.emptyAction}
      </>
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
      {feedback}
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
