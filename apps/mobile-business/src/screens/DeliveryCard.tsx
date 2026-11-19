import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Product, StockDelivery } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { orderQuantity, parseDelivery } from '../stock';
import { Button, Card, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 477: "Przyjmij dostawę" in the business app, as in the cabinet (476) — the whole order from
 * the supplier on one card: the pieces that came for each product, added to the stock in one
 * step. The products to order start with the suggested numbers of "Wyślij zamówienie" (task
 * 474), the others empty; with suppliers written, the card can show one supplier only.
 */
export function DeliveryCard(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  products: Product[];
  sold30: ReadonlyMap<string, number>;
  onSaved: (result: StockDelivery) => void;
}) {
  const { api, t, salon } = props;
  const p = t.products;
  const active = props.products.filter((x) => x.active);
  const [pieces, setPieces] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      active.map((x) => [
        x.id,
        x.lowStock || x.stockQuantity === 0
          ? String(orderQuantity(x, props.sold30.get(x.id) ?? 0))
          : '',
      ]),
    ),
  );
  /** "" = all suppliers. */
  const [supplier, setSupplier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const suppliers = [
    ...new Map(
      active
        .filter((x) => x.supplier !== null)
        .map((x) => [x.supplier!.toLocaleLowerCase(), x.supplier!]),
    ).values(),
  ].sort((a, b) => a.localeCompare(b));
  const shown = active.filter(
    (x) => supplier === '' || x.supplier?.toLocaleLowerCase() === supplier.toLocaleLowerCase(),
  );
  const parsed = shown.map((x) => ({ product: x, n: parseDelivery(pieces[x.id] ?? '') }));
  const wrong = parsed.some((r) => r.n === undefined);
  const items = parsed.flatMap(({ product, n }) =>
    typeof n === 'number' ? [{ productId: product.id, quantity: n }] : [],
  );
  const total = items.reduce((sum, i) => sum + i.quantity, 0);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      props.onSaved(await api.delivery(salon.orgId, salon.locationId, items));
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View testID="delivery">
      <Card>
        <Text role="heading" aria-level={3} style={styles.title}>
          {p.deliveryTitle}
        </Text>
        <Text style={styles.muted}>{p.deliveryHint}</Text>
        {suppliers.length > 0 ? (
          <View style={styles.choices} testID="delivery-suppliers">
            {['', ...suppliers].map((name) => (
              <Button
                key={name || '-'}
                kind={supplier === name ? 'primary' : 'secondary'}
                label={name || p.supplierAll}
                onPress={() => setSupplier(name)}
              />
            ))}
          </View>
        ) : null}
        {parsed.map(({ product: x, n }) => (
          <View key={x.id} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{x.name}</Text>
              <Text style={styles.muted}>
                {x.stockQuantity === null
                  ? p.stocktakeWasNone
                  : fill(p.stocktakeWas, { n: String(x.stockQuantity) })}
              </Text>
            </View>
            <TextInput
              accessibilityLabel={fill(p.deliveryCame, { name: x.name })}
              placeholder="—"
              placeholderTextColor={colors.placeholder}
              keyboardType="number-pad"
              value={pieces[x.id] ?? ''}
              onChangeText={(value) => setPieces({ ...pieces, [x.id]: value })}
              style={[styles.input, n === undefined && { borderColor: colors.danger }]}
            />
          </View>
        ))}
        {wrong ? <Text style={styles.warn}>{p.deliveryInvalid}</Text> : null}
        {error ? <ErrorText>{error}</ErrorText> : null}
        <View style={{ marginTop: 8 }}>
          <Button
            label={fill(p.deliverySave, { n: String(total) })}
            busy={busy}
            disabled={wrong || items.length === 0}
            onPress={() => void save()}
          />
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '700', color: colors.ink },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8 },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  muted: { color: colors.muted, fontSize: 14 },
  warn: { color: colors.danger, fontSize: 14, marginTop: 8 },
  input: {
    width: 80,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
    color: colors.ink,
    textAlign: 'right',
  },
});
