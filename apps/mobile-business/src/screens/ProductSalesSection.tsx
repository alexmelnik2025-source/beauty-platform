import { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ApiError,
  type BusinessApi,
  type Locale,
  type ProductList,
  type VisitProductSales,
} from '../api';
import { parseBarcode } from '../barcode';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { Button, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';
import { SalonReadCache, useScreenLifetime, withNetworkTimeout } from './HistoryScreen';

const catalogueCache = new SalonReadCache<ProductList['products']>();
const salesCache = new SalonReadCache<VisitProductSales>();

export function invalidateSaleStock(salon: SalonChoice, salesChanged: boolean) {
  catalogueCache.clear(salon);
  if (salesChanged) salesCache.clear(salon);
}

function readCatalogue(api: BusinessApi, salon: SalonChoice) {
  return catalogueCache.read(salon, async () => {
    const list = await withNetworkTimeout(api.products(salon.orgId, salon.locationId));
    return list.products.filter((product) => product.active);
  });
}

/**
 * Task 396: "Produkty" in the card of a visit that took place — the same as in the cabinet
 * (task 395): a tap on a product of the salon's list notes one sold, «Usuń» removes a
 * mistake. Not part of the visit price, loyalty points or discounts.
 * Task 524: "Kod kreskowy" — a code typed (or from a scanner) adds one piece of the product with
 * that code, as in the cabinet; shown when some product of the salon has a code.
 */
export const ProductSalesSection = memo(function ProductSalesSection(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  appointmentId: string;
  canChange: boolean;
}) {
  const { api, t, salon, appointmentId, canChange } = props;
  const p = t.products;
  const [codeError, setCodeError] = useState('');
  const [products, setProducts] = useState<ProductList['products']>([]);
  const [sales, setSales] = useState<VisitProductSales | null>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const money = (hundredths: number) => formatPrice(hundredths, salon.currency, props.locale);

  const lifetime = useScreenLifetime(salon, appointmentId);

  useEffect(() => {
    let active = true;
    Promise.all([
      canChange ? readCatalogue(api, salon) : [],
      salesCache.read(
        salon,
        () => withNetworkTimeout(api.productSales(salon.orgId, salon.locationId, appointmentId)),
        appointmentId,
      ),
    ]).then(
      ([list, sold]) => {
        if (!active) return;
        setProducts(list);
        setSales(sold);
      },
      (e) => {
        if (active) setError(errorText(e, t));
      },
    );
    return () => {
      active = false;
    };
  }, [api, salon, appointmentId, canChange, t]);

  const run = async (
    action: () => Promise<VisitProductSales>,
    onSold?: () => void,
    onFailure: (message: string) => void = setError,
  ) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setCodeError('');
    setError('');
    try {
      let sold: VisitProductSales;
      try {
        sold = await action();
      } catch (e) {
        const message =
          e instanceof ApiError && e.code === 'OUT_OF_STOCK' ? p.outOfStock : errorText(e, t);
        invalidateSaleStock(salon, true);
        if (!signal.aborted) onFailure(message);
        return;
      }
      catalogueCache.clear(salon);
      salesCache.set(salon, sold, appointmentId);
      if (signal.aborted) return;
      setSales(sold);
      onSold?.();
      if (canChange) {
        const list = await readCatalogue(api, salon);
        if (!signal.aborted) setProducts(list);
      }
    } catch (e) {
      if (!signal.aborted) setError(errorText(e, t));
    } finally {
      submitting.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };

  const withCodes = products.some((x) => x.barcode !== null);

  if (!sales) return error ? <ErrorText>{error}</ErrorText> : null;
  if (sales.sales.length === 0 && (!canChange || products.length === 0)) return null;

  return (
    <View style={{ gap: 6 }} testID="visit-products">
      <Text role="heading" aria-level={3} style={styles.label}>
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
      {canChange && withCodes ? (
        <BarcodeForm
          products={products}
          p={p}
          busy={busy}
          codeError={codeError}
          setCodeError={setCodeError}
          clearError={() => setError('')}
          onSell={(id, onSold) =>
            void run(
              () => api.addProductSale(salon.orgId, salon.locationId, appointmentId, id),
              onSold,
              setCodeError,
            )
          }
        />
      ) : null}
      {canChange && products.length > 0 ? (
        <View style={styles.chips}>
          {products.map((x) => (
            <Button
              key={x.id}
              kind="secondary"
              label={`+ ${x.name} · ${money(x.priceGrosze)}${
                x.stockQuantity === null
                  ? ''
                  : ` · ${
                      x.stockQuantity > 0
                        ? fill(p.stockLeft, { n: String(x.stockQuantity) })
                        : p.stockNone
                    }`
              }${x.lowStock && x.stockQuantity !== 0 ? ` · ${p.lowBadge}` : ''}`}
              a11yLabel={fill(p.addSaleFor, { name: x.name })}
              disabled={busy || (x.stockQuantity !== null && x.stockQuantity < 1)}
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
});

function BarcodeForm({
  products,
  p,
  busy,
  codeError,
  setCodeError,
  clearError,
  onSell,
}: {
  products: ProductList['products'];
  p: Dictionary['products'];
  busy: boolean;
  codeError: string;
  setCodeError: (error: string) => void;
  clearError: () => void;
  onSell: (id: string, onSold: () => void) => void;
}) {
  const [code, setCode] = useState('');
  const wanted = parseBarcode(code);
  const codeHint = wanted === undefined ? p.barcodeInvalid : codeError;
  /** Task 524: one piece of the product with this code, or "no such product". */
  const sellByCode = () => {
    if (busy || !wanted) return;
    const found = products.find((x) => x.barcode === wanted);
    if (!found) {
      clearError();
      setCodeError(fill(p.codeUnknown, { code: wanted }));
      return;
    }
    onSell(found.id, () => setCode(''));
  };
  return (
    <View style={styles.codeRow}>
      <View style={styles.codeField}>
        <Text style={styles.muted}>{p.saleByCode}</Text>
        <TextInput
          accessibilityLabel={p.saleByCode}
          value={code}
          maxLength={40}
          autoCapitalize="characters"
          autoCorrect={false}
          editable={!busy}
          aria-invalid={Boolean(codeHint)}
          aria-describedby={codeHint ? 'visit-barcode-error' : undefined}
          onChangeText={(value) => {
            setCode(value);
            setCodeError('');
          }}
          onSubmitEditing={sellByCode}
          style={[styles.input, !!codeHint && { borderColor: colors.danger }]}
          testID="visit-products-code"
        />
        {codeHint ? (
          <Text role="alert" nativeID="visit-barcode-error" style={styles.fieldError}>
            ! {codeHint}
          </Text>
        ) : null}
      </View>
      <Button
        kind="secondary"
        label={p.addByCode}
        disabled={busy || !wanted}
        onPress={sellByCode}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  label: { marginTop: 8, fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    justifyContent: 'space-between',
  },
  name: {
    fontSize: 16,
    color: colors.ink,
    flexShrink: 1,
    flexGrow: 1,
    flexBasis: 150,
    minWidth: 0,
  },
  muted: { color: colors.muted, fontSize: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  codeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  codeField: { flexGrow: 1, flexShrink: 1, flexBasis: 180, minWidth: 0, maxWidth: '100%', gap: 4 },
  fieldError: { color: colors.danger, fontSize: 15 },
  input: {
    minHeight: 44,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink,
  },
});
