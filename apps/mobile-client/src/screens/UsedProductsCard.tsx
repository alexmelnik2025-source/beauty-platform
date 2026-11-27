import { memo, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { ClientApi, Locale } from '../api';
import type { BookingPreset } from '../booking';
import { API_URL } from '../config';
import { formatDay, formatPrice } from '../format';
import { fill, type Dictionary } from '../i18n';
import { usedProductLists } from '../shop';
import { ProductActionButton, useProductLock, useVisitProductList } from './VisitProductsCard';
import { Button, Chip, colors } from '../ui';

/** Products marked by the specialist. Pickup orders use the completed visit;
 * only products selected for a future visit accompany a new booking. */
type Props = {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  visitId: string;
  onBookNext: (preset: BookingPreset) => void;
};
export function UsedProductsCard(props: Props) {
  return <UsedProductsContent key={props.visitId} {...props} />;
}

function UsedProductsContent(props: Props) {
  const { api, t, locale, visitId } = props;
  const s = t.visitProducts;
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) =>
    setSelected((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id],
    );
  const [buying, setBuying] = useState<string | null>(null);
  const lock = useProductLock();
  const { data, setData, feedback, refresh } = useVisitProductList(
    api,
    visitId,
    t,
    usedProductLists,
    api.usedProducts,
  );
  if (!data)
    return (
      feedback && (
        <View role="region" aria-label={s.usedTitle} style={styles.card}>
          <Text role="heading" aria-level={2} style={styles.title}>
            {s.usedTitle}
          </Text>
          {feedback}
        </View>
      )
    );
  if (!data.products.length) return null;
  const next = data.nextVisit;
  const when = next ? `${next.time} · ${formatDay(next.date, locale)}` : '';
  const toBring = data.products
    .filter((p) => p.available && selected.includes(p.id))
    .map((p) => p.id);

  return (
    <View role="region" aria-label={s.usedTitle} style={styles.card} testID="used-products">
      <Text role="heading" aria-level={2} style={styles.title}>
        {s.usedTitle}
      </Text>
      {feedback}
      {data.products.map((p) => (
        <View key={p.id} style={styles.item}>
          <ProductDetails
            name={p.name}
            brand={p.brand}
            photoId={p.photoId}
            amount={p.priceGrosze}
            currency={data.currency}
            locale={locale}
            status={!p.available && !p.reservedForNext && !p.pickupStatus ? s.unavailable : ''}
          />
          {p.description && <Text style={styles.muted}>{p.description}</Text>}
          {p.pickupStatus ? (
            <Text role="status" style={styles.saved}>
              {p.pickupStatus === 'handed' ? s.pickupHanded : s.pickupOrdered}
            </Text>
          ) : p.available ? (
            <>
              <Button
                kind="secondary"
                label={s.buy}
                a11yLabel={`${s.buy}: ${p.name}`}
                onPress={() => setBuying(buying === p.id ? null : p.id)}
              />
              {buying === p.id && (
                <ProductActionButton
                  lock={lock}
                  refresh={refresh}
                  t={t}
                  api={api}
                  label={s.orderForPickup}
                  a11yLabel={`${s.orderForPickup}: ${p.name}`}
                  action={async () => setData(await api.orderPickup(visitId, p.id))}
                />
              )}
            </>
          ) : null}
          {!next && p.available && (
            <Chip
              label={s.saveForNext}
              a11yLabel={`${s.saveForNext}: ${p.name}`}
              pressed={selected.includes(p.id)}
              onPress={() => toggle(p.id)}
            />
          )}
          {next && p.reservedForNext ? (
            <Text role="status" style={styles.saved}>
              ✓ {fill(s.savedForNext, { when })}
            </Text>
          ) : next ? (
            <ProductActionButton
              lock={lock}
              refresh={refresh}
              t={t}
              api={api}
              kind="secondary"
              label={s.saveForNext}
              a11yLabel={`${s.saveForNext}: ${p.name}`}
              disabled={!p.available}
              action={async () => setData(await api.reserveForNext(visitId, p.id))}
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
    </View>
  );
}

const ProductDetails = memo(function ProductDetails({
  name,
  brand,
  photoId,
  amount,
  currency,
  locale,
  status,
}: {
  name: string;
  brand: string | null;
  photoId: string | null;
  amount: number;
  currency: string;
  locale: Locale;
  status: string;
}) {
  const price = formatPrice(amount, currency, locale);
  return (
    <View style={styles.row}>
      {photoId ? (
        <Image
          accessible
          accessibilityLabel={name}
          resizeMethod="resize"
          source={{ uri: `${API_URL}/v1/public/photos/${photoId}` }}
          style={styles.photo}
        />
      ) : null}
      <View style={styles.grow}>
        <Text style={styles.name}>
          {name}
          {brand ? <Text style={styles.muted}> · {brand}</Text> : null}
        </Text>
        <Text style={styles.muted}>
          {price}
          {status ? ` · ${status}` : ''}
        </Text>
      </View>
    </View>
  );
});

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
