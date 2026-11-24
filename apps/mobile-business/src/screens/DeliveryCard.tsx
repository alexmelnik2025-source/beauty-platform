import { memo, useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Product, StockDelivery } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { orderQuantity, parseDelivery } from '../stock';
import { Button, Card, colors, ErrorText, Pressable } from '../ui';
import { invalidateSaleStock } from './ProductSalesSection';
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
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const changeQuantity = useCallback((id: string, value: string) => {
    setPieces((current) => ({ ...current, [id]: value }));
    setError('');
  }, []);

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
  const failedItem = error && items.length === 1 ? items[0]?.productId : undefined;
  const total = items.reduce((sum, i) => sum + i.quantity, 0);

  const save = async () => {
    if (submitting.current || wrong || !items.length) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api.delivery(salon.orgId, salon.locationId, items);
      invalidateSaleStock(salon, false);
      props.onSaved(result);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      submitting.current = false;
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
          <View
            role="group"
            accessibilityLabel={p.supplier}
            style={styles.choices}
            testID="delivery-suppliers"
          >
            {['', ...suppliers].map((name) => (
              <Pressable
                key={name}
                accessibilityRole="button"
                accessibilityState={{ selected: supplier === name, disabled: busy }}
                disabled={busy}
                aria-pressed={supplier === name}
                style={[styles.filter, supplier === name && styles.activeFilter]}
                onPress={() => {
                  setSupplier(name);
                  setError('');
                }}
              >
                <Text style={[styles.filterText, supplier === name && styles.activeText]}>
                  {name || p.supplierAll}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {parsed.map(({ product: x, n }) => (
          <DeliveryRow
            key={x.id}
            product={x}
            p={p}
            busy={busy}
            value={pieces[x.id] ?? ''}
            fieldError={n === undefined ? p.deliveryInvalid : failedItem === x.id ? error : ''}
            hasSaveError={Boolean(error) && n !== null}
            onChange={changeQuantity}
          />
        ))}
        {error && !failedItem ? (
          <View nativeID="delivery-save-error">
            <ErrorText>! {error}</ErrorText>
          </View>
        ) : null}
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

const DeliveryRow = memo(function DeliveryRow({
  product: x,
  p,
  busy,
  value,
  fieldError,
  hasSaveError,
  onChange,
}: {
  product: Product;
  p: Dictionary['products'];
  busy: boolean;
  value: string;
  fieldError: string;
  hasSaveError: boolean;
  onChange: (id: string, value: string) => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.details}>
        <Text style={styles.name}>{x.name}</Text>
        <Text style={styles.muted}>
          {x.stockQuantity === null
            ? p.stocktakeWasNone
            : fill(p.stocktakeWas, { n: String(x.stockQuantity) })}
        </Text>
      </View>
      <View style={styles.quantity}>
        <TextInput
          accessibilityLabel={fill(p.deliveryCame, { name: x.name })}
          editable={!busy}
          aria-invalid={Boolean(fieldError)}
          aria-describedby={
            fieldError ? `delivery-error-${x.id}` : hasSaveError ? 'delivery-save-error' : undefined
          }
          placeholder="—"
          placeholderTextColor={colors.placeholder}
          keyboardType="number-pad"
          value={value}
          onChangeText={(text) => onChange(x.id, text)}
          style={[styles.input, Boolean(fieldError) && { borderColor: colors.danger }]}
        />
        {fieldError ? (
          <Text role="alert" nativeID={`delivery-error-${x.id}`} style={styles.fieldError}>
            ! {fieldError}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '700', color: colors.ink },
  filter: {
    maxWidth: '100%',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 12,
    borderColor: colors.line,
  },
  activeFilter: { backgroundColor: colors.ink, borderColor: colors.ink },
  filterText: {
    maxWidth: '100%',
    color: colors.ink,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  activeText: { color: colors.card },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 },
  details: { flexGrow: 1, flexShrink: 1, flexBasis: 160, minWidth: 0 },
  quantity: { flexBasis: 100, flexGrow: 1, gap: 4 },
  fieldError: { color: colors.danger, fontSize: 15 },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  muted: { color: colors.muted, fontSize: 14 },
  input: {
    minHeight: 44,
    minWidth: 0,
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
