import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, Locale, ProductList, VisitProductSales } from '../api';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { Button, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 396: "Produkty" in the card of a visit that took place — the same as in the cabinet
 * (task 395): a tap on a product of the salon's list notes one sold, «Usuń» removes a
 * mistake. Not part of the visit price, loyalty points or discounts.
 */
export function ProductSalesSection(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  appointmentId: string;
  canChange: boolean;
}) {
  const { api, t, salon, appointmentId, canChange } = props;
  const p = t.products;
  const [products, setProducts] = useState<ProductList['products']>([]);
  const [sales, setSales] = useState<VisitProductSales | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const money = (hundredths: number) => formatPrice(hundredths, salon.currency, props.locale);

  const load = useCallback(async () => {
    try {
      const [list, sold] = await Promise.all([
        canChange
          ? api.products(salon.orgId, salon.locationId)
          : Promise.resolve<ProductList>({ products: [] }),
        api.productSales(salon.orgId, salon.locationId, appointmentId),
      ]);
      setProducts(list.products.filter((x) => x.active));
      setSales(sold);
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, appointmentId, canChange, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<VisitProductSales>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setSales(await action());
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  if (!sales) return null;
  if (sales.sales.length === 0 && (!canChange || products.length === 0)) return null;

  return (
    <View style={{ gap: 6 }} testID="visit-products">
      <Text style={styles.label}>
        {sales.totalGrosze > 0
          ? fill(p.soldTotal, { amount: money(sales.totalGrosze) })
          : p.sold.toUpperCase()}
      </Text>
      {sales.sales.map((s) => (
        <View key={s.id} style={styles.row}>
          <Text style={styles.name}>{s.quantity > 1 ? `${s.name} × ${s.quantity}` : s.name}</Text>
          <Text style={styles.muted}>{money(s.totalGrosze)}</Text>
          {canChange ? (
            <Button
              kind="link"
              label={p.removeSale}
              a11yLabel={fill(p.removeSaleFor, { name: s.name })}
              disabled={busy}
              onPress={() =>
                void run(() =>
                  api.removeProductSale(salon.orgId, salon.locationId, appointmentId, s.id),
                )
              }
            />
          ) : null}
        </View>
      ))}
      {canChange && products.length > 0 ? (
        <View style={styles.chips}>
          {products.map((x) => (
            <Button
              key={x.id}
              kind="secondary"
              label={`+ ${x.name} · ${money(x.priceGrosze)}`}
              a11yLabel={fill(p.addSaleFor, { name: x.name })}
              disabled={busy}
              onPress={() =>
                void run(() =>
                  api.addProductSale(salon.orgId, salon.locationId, appointmentId, x.id),
                )
              }
            />
          ))}
        </View>
      ) : null}
      <Text style={styles.muted}>{p.soldHint}</Text>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { marginTop: 8, fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
  name: { fontSize: 16, color: colors.ink, flexShrink: 1, flexGrow: 1 },
  muted: { color: colors.muted, fontSize: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
