import { useCallback, useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { ClientApi, Locale, VisitProducts } from '../api';
import { API_URL } from '../config';
import { errorText } from '../errors';
import { formatPrice } from '../format';
import { fill, type Dictionary } from '../i18n';
import { Button, colors, ErrorText } from '../ui';

/**
 * Task Q3 (screen B in the app): "Produkty do odbioru" in the visit card of "Moje wizyty" — what
 * I put aside for this visit, and "+ Dodaj produkt do tej wizyty" (folded) with the salon's
 * products; "Odbiorę przy wizycie" puts one aside, paid at the salon. Nothing is shown when the
 * salon has no products for clients and nothing was put aside — the visit card stays as it was.
 */
export function VisitProductsCard(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  visitId: string;
}) {
  const { api, t, locale, visitId } = props;
  const s = t.visitProducts;
  const [data, setData] = useState<VisitProducts | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    () =>
      api
        .visitProducts(visitId)
        .then(setData)
        .catch(() => setData(null)),
    [api, visitId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<VisitProducts>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setData(await action());
    } catch (e) {
      setError(errorText(e, t));
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!data) return null;
  const reserved = data.reservations.filter((r) => r.status !== 'cancelled');
  if (reserved.length === 0 && (!data.canChange || data.available.length === 0)) return null;
  const money = (n: number) => formatPrice(n, data.currency, locale);
  const photo = (id: string) => ({ uri: `${API_URL}/v1/public/photos/${id}` });

  return (
    <View role="region" aria-label={s.title} style={styles.card} testID="visit-products">
      <Text role="heading" aria-level={2} style={styles.title}>
        {s.title}
      </Text>
      {reserved.map((r) => (
        <View key={r.id} style={styles.row}>
          {r.photoId ? <Image source={photo(r.photoId)} style={styles.photo} /> : null}
          <View style={styles.grow}>
            <Text style={styles.name}>{r.quantity > 1 ? `${r.name} × ${r.quantity}` : r.name}</Text>
            <Text style={styles.muted}>
              {r.status === 'reserved' ? s.statusReserved : null}
              {r.status === 'handed' ? s.statusHanded : null}
              {r.status === 'expired' ? s.statusExpired : null}
            </Text>
          </View>
          <Text style={styles.price}>{money(r.totalGrosze)}</Text>
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
          <Button kind="secondary" label={s.add} onPress={() => setOpen(!open)} />
          {open
            ? data.available.map((p) => (
                <View key={p.id} style={styles.row}>
                  {p.photoId ? <Image source={photo(p.photoId)} style={styles.photo} /> : null}
                  <View style={styles.grow}>
                    <Text style={styles.name}>
                      {p.name}
                      {p.brand ? <Text style={styles.muted}> · {p.brand}</Text> : null}
                    </Text>
                    <Text style={styles.muted}>
                      {money(p.priceGrosze)}
                      {!p.available ? ` · ${s.unavailable}` : ''}
                    </Text>
                  </View>
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
  grow: { flexGrow: 1, flexShrink: 1, gap: 2, minWidth: 140 },
  photo: { width: 48, height: 48, borderRadius: 8 },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  price: { fontSize: 15, color: colors.ink },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
});
