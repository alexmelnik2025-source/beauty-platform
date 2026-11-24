import { memo, useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { ClientApi, Locale, VisitProducts } from '../api';
import { API_URL } from '../config';
import { errorText } from '../errors';
import { formatPrice } from '../format';
import { fill, type Dictionary } from '../i18n';
import { visitProductLists, invalidateProductLists } from '../shop';
import { Button, colors, ErrorText } from '../ui';

/**
 * Task Q3 (screen B in the app): "Produkty do odbioru" in the visit card of "Moje wizyty" — what
 * I put aside for this visit, and "+ Dodaj produkt do tej wizyty" (folded) with the salon's
 * products; "Odbiorę przy wizycie" puts one aside, paid at the salon. Nothing is shown when the
 * salon has no products for clients and nothing was put aside — the visit card stays as it was.
 */
type Props = {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  visitId: string;
};
export function VisitProductsCard(props: Props) {
  return <VisitProductsContent key={props.visitId} {...props} />;
}

function VisitProductsContent(props: Props) {
  const { api, t, locale, visitId } = props;
  const s = t.visitProducts;
  const [data, setData] = useState<VisitProducts | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    visitProductLists
      .read(api, visitId, () => api.visitProducts(visitId))
      .then(
        (items) => {
          if (live) setData(items);
        },
        () => {
          if (live) setData(null);
        },
      );
    return () => {
      live = false;
    };
  }, [api, visitId]);

  const run = async (action: () => Promise<VisitProducts>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setData(await action());
    } catch (e) {
      setError(errorText(e, t));
      await api.visitProducts(visitId).then(setData, () => setData(null));
    } finally {
      invalidateProductLists(api);
      setBusy(false);
    }
  };

  if (!data) return null;
  const reserved = data.reservations.filter((r) => r.status !== 'cancelled');
  if (reserved.length === 0 && (!data.canChange || data.available.length === 0)) return null;
  const money = (n: number) => formatPrice(n, data.currency, locale);

  return (
    <View role="region" aria-label={s.title} style={styles.card} testID="visit-products">
      <Text role="heading" aria-level={2} style={styles.title}>
        {s.title}
      </Text>
      {reserved.map((r) => (
        <View key={r.id} style={styles.row}>
          <ProductDetails
            name={r.name}
            photoId={r.photoId}
            quantity={r.quantity}
            amount={r.totalGrosze}
            currency={data.currency}
            locale={locale}
            status={
              r.status === 'reserved'
                ? s.statusReserved
                : r.status === 'handed'
                  ? s.statusHanded
                  : s.statusExpired
            }
          />
          {data.canChange && r.status === 'reserved' ? (
            <Button
              kind="link"
              label={s.giveBack}
              a11yLabel={`${s.giveBack}: ${r.name}`}
              disabled={busy}
              onPress={() => void run(() => api.unreserveProduct(visitId, r.id))}
            />
          ) : null}
        </View>
      ))}
      {reserved.length > 0 ? (
        <Text style={styles.muted}>{fill(s.total, { amount: money(data.totalGrosze) })}</Text>
      ) : null}
      {data.canChange && data.available.length > 0 ? (
        <>
          <Button kind="secondary" label={s.add} expanded={open} onPress={() => setOpen(!open)} />
          {open
            ? data.available.map((p) => (
                <View key={p.id} style={styles.row}>
                  <ProductDetails
                    name={p.name}
                    photoId={p.photoId}
                    brand={p.brand}
                    amount={p.priceGrosze}
                    currency={data.currency}
                    locale={locale}
                    available={p.available}
                    status={s.unavailable}
                  />
                  <Button
                    kind="secondary"
                    label={s.reserve}
                    a11yLabel={`${s.reserve}: ${p.name}`}
                    disabled={busy || !p.available}
                    onPress={() => void run(() => api.reserveProduct(visitId, p.id))}
                  />
                </View>
              ))
            : null}
          <Text style={styles.muted}>{s.pickup}</Text>
        </>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
}

const ProductDetails = memo(function ProductDetails({
  name,
  photoId,
  quantity,
  brand,
  amount,
  currency,
  locale,
  available,
  status,
}: {
  name: string;
  photoId: string | null;
  quantity?: number;
  brand?: string | null;
  amount: number;
  currency: string;
  locale: Locale;
  available?: boolean;
  status: string;
}) {
  const price = formatPrice(amount, currency, locale);
  return (
    <>
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
          {quantity && quantity > 1 ? `${name} × ${quantity}` : name}
          {brand ? <Text style={styles.muted}> · {brand}</Text> : null}
        </Text>
        {available === undefined ? (
          <>
            <Text style={styles.price}>{price}</Text>
            <Text style={styles.muted}>{status}</Text>
          </>
        ) : (
          <Text style={styles.muted}>
            {price}
            {!available ? ` · ${status}` : ''}
          </Text>
        )}
      </View>
    </>
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  grow: { flexGrow: 1, flexShrink: 1, gap: 2, flexBasis: 140, minWidth: 0 },
  photo: { width: 48, height: 48, borderRadius: 8 },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  price: { fontSize: 15, color: colors.ink },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
});
