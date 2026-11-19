import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Product, Stocktake } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { parseStock } from '../stock';
import { Button, Card, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 458: "Inwentaryzacja" in the business app, as in the cabinet (457) — the owner counts what
 * is on the shelf and writes the numbers for all products on one card; the server writes each
 * difference to "Historia magazynu" and says how many pieces were missing or extra. An empty
 * field leaves the product as it is.
 */
export function StocktakeCard(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  products: Product[];
  onSaved: (result: Stocktake) => void;
}) {
  const { api, t, salon, products } = props;
  const p = t.products;
  const [counts, setCounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      products.map((x) => [x.id, x.stockQuantity === null ? '' : String(x.stockQuantity)]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const parsed = products.map((x) => ({ product: x, count: parseStock(counts[x.id] ?? '') }));
  const wrong = parsed.some((r) => r.count === undefined);
  const changes = parsed.flatMap(({ product, count }) =>
    typeof count === 'number' && count !== product.stockQuantity
      ? [{ productId: product.id, quantity: count }]
      : [],
  );

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      props.onSaved(await api.stocktake(salon.orgId, salon.locationId, changes));
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View testID="stocktake">
      <Card>
        <Text role="heading" aria-level={3} style={styles.title}>
          {p.stocktakeTitle}
        </Text>
        <Text style={styles.muted}>{p.stocktakeHint}</Text>
        {parsed.map(({ product: x, count }) => (
          <View key={x.id} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{x.name}</Text>
              <Text style={styles.muted}>
                {x.stockQuantity === null
                  ? p.stocktakeWasNone
                  : fill(p.stocktakeWas, { n: String(x.stockQuantity) })}
                {typeof count === 'number' && x.stockQuantity !== null && count !== x.stockQuantity
                  ? ` · ${
                      count < x.stockQuantity
                        ? fill(p.stocktakeMissing, { n: String(x.stockQuantity - count) })
                        : fill(p.stocktakeExtra, { n: String(count - x.stockQuantity) })
                    }`
                  : ''}
              </Text>
            </View>
            <TextInput
              accessibilityLabel={fill(p.stocktakeCount, { name: x.name })}
              placeholder="—"
              placeholderTextColor={colors.placeholder}
              keyboardType="number-pad"
              value={counts[x.id] ?? ''}
              onChangeText={(value) => setCounts({ ...counts, [x.id]: value })}
              style={[styles.input, count === undefined && { borderColor: colors.danger }]}
            />
          </View>
        ))}
        {wrong ? <Text style={styles.warn}>{p.stockInvalid}</Text> : null}
        {error ? <ErrorText>{error}</ErrorText> : null}
        <View style={{ marginTop: 8 }}>
          <Button
            label={p.stocktakeSave}
            busy={busy}
            disabled={wrong || changes.length === 0}
            onPress={() => void save()}
          />
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '700', color: colors.ink },
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
