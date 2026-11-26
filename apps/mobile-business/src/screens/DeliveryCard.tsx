import { memo, useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Product, StockDelivery } from '../api';
import { errorText } from '../errors';
import { useFormDraft } from '../formDrafts';
import { fill, type Dictionary } from '../i18n';
import { orderQuantity, parseDelivery } from '../stock';
import { Button, Card, colors, ErrorText, Pressable } from '../ui';
import { invalidateSaleStock } from './ProductSalesSection';
import type { SalonChoice } from './SalonsScreen';

const EMPTY_DELIVERY: { supplier: string; pieces: Record<string, string> } = {
  supplier: '',
  pieces: {},
};

// Reopening a delivery while it is being received must not book the same pieces twice.
type PendingDelivery = {
  done: Promise<string>;
  onSaved: (result: StockDelivery) => void;
};
const pendingDeliveries = new WeakMap<SalonChoice, PendingDelivery>();

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
  const { api, t, salon, onSaved } = props;
  const p = t.products;
  const active = props.products.filter((x) => x.active);
  const [draft, setDraft] = useFormDraft(
    `delivery.${salon.orgId}.${salon.locationId}`,
    EMPTY_DELIVERY,
  );
  const [pending, setPending] = useState(() => pendingDeliveries.get(salon));
  const busy = Boolean(pending);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!pending) return;
    let open = true;
    pending.onSaved = onSaved;
    void pending.done.then((message) => {
      if (open) {
        setPending(undefined);
        setError(message);
      }
    });
    return () => {
      open = false;
    };
  }, [pending, onSaved]);

  const changeQuantity = useCallback(
    (id: string, value: string) => {
      setDraft((current) => ({ ...current, pieces: { ...current.pieces, [id]: value } }));
      setError('');
    },
    [setDraft],
  );

  const suppliers = [
    ...new Map(
      active
        .filter((x) => x.supplier !== null)
        .map((x) => [x.supplier!.toLocaleLowerCase(), x.supplier!]),
    ).values(),
  ].sort((a, b) => a.localeCompare(b));
  const supplier =
    suppliers.find((name) => name.toLocaleLowerCase() === draft.supplier.toLocaleLowerCase()) ?? '';
  const shown = active.filter(
    (x) => supplier === '' || x.supplier?.toLocaleLowerCase() === supplier.toLocaleLowerCase(),
  );
  const parsed = shown.map((product) => {
    const value =
      draft.pieces[product.id] ??
      (product.lowStock || product.stockQuantity === 0
        ? String(orderQuantity(product, props.sold30.get(product.id) ?? 0))
        : '');
    return { product, value, n: parseDelivery(value) };
  });
  const wrong = parsed.some((r) => r.n === undefined);
  const items = parsed.flatMap(({ product, n }) =>
    typeof n === 'number' ? [{ productId: product.id, quantity: n }] : [],
  );
  const failedItem = error && items.length === 1 ? items[0]?.productId : undefined;
  const total = items.reduce((sum, i) => sum + i.quantity, 0);

  const save = () => {
    if (pendingDeliveries.has(salon) || wrong || !items.length) return;
    setError('');
    const delivery: PendingDelivery = {
      onSaved,
      done: api
        .delivery(salon.orgId, salon.locationId, items)
        .then((result) => {
          setDraft(EMPTY_DELIVERY);
          invalidateSaleStock(salon, false);
          delivery.onSaved(result);
          return '';
        })
        .catch((e: unknown) => errorText(e, t))
        .finally(() => pendingDeliveries.delete(salon)),
    };
    pendingDeliveries.set(salon, delivery);
    setPending(delivery);
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
                  setDraft((current) => ({ ...current, supplier: name }));
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
        {parsed.map(({ product: x, value, n }) => (
          <DeliveryRow
            key={x.id}
            product={x}
            p={p}
            busy={busy}
            value={value}
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
            onPress={save}
          />
          {draft !== EMPTY_DELIVERY ? (
            <Button
              kind="secondary"
              label={p.cancel}
              disabled={busy}
              onPress={() => {
                setDraft(EMPTY_DELIVERY);
                setError('');
              }}
            />
          ) : null}
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
