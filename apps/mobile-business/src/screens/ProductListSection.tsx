import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Locale, Product, StockHistory } from '../api';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { shareCsv } from '../share';
import { parseStock, toOrderNames } from '../stock';
import { parseTip as parseAmount, tipInput as amountInput } from '../tip';

/** Task 448: "" → null (not written), "20,50" → 2050; anything else → undefined (wrong). */
function parseCost(text: string): number | null | undefined {
  if (text.trim() === '') return null;
  return parseAmount(text) ?? undefined;
}
import { Button, Card, colors, ErrorText } from '../ui';
import { csvTools } from './csvTools';
import { StocktakeCard } from './StocktakeCard';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 397: "Produkty" in "Usługi" of the business app — the salon's list of products sold at
 * a visit, as in the cabinet (task 395): add, change the name or price, «Nie sprzedajemy» /
 * «Sprzedajemy», remove (with a question; past sales stay in the reports).
 * Task 431: "W magazynie" — pieces in stock (empty = not counted), as in the cabinet (430).
 * Task 435: "Kończy się przy" — the salon's own number of pieces that is already few; such
 * products say "Kończy się" and are listed in "Do zamówienia", as in the cabinet (434).
 * Task 442: "Wartość magazynu" — what the pieces in stock are worth at the selling prices.
 * Task 441: "Historia" — the product's last stock changes (sale, delivery, by hand), who and when.
 * Task 439: "Dostawa" — how many pieces arrived; the server adds them to the stock.
 * Task 437: "CSV stanu magazynowego" — the list as a file for the supplier (shared on a phone,
 * saved in a browser).
 * Task 458: "Inwentaryzacja" — the numbers counted on the shelf for all products on one card.
 * Task 464: "Dostawca" — whom the salon orders the product from; the stock CSV for one supplier.
 */
export function ProductListSection(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
}) {
  const { api, t, salon } = props;
  const p = t.products;
  const [products, setProducts] = useState<Product[] | null>(null);
  /** Task 461: pieces sold at the visits of the last 30 days, by product. */
  const [sold30, setSold30] = useState<Map<string, number>>(new Map());
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    name: '',
    price: '',
    cost: '',
    stock: '',
    low: '',
    supplier: '',
  });
  const [askRemove, setAskRemove] = useState<string | null>(null);
  const [history, setHistory] = useState<{
    id: string;
    rows: StockHistory['movements'];
  } | null>(null);
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [delivery, setDelivery] = useState('');
  const [writeOffId, setWriteOffId] = useState<string | null>(null);
  const [writeOff, setWriteOff] = useState({ quantity: '', note: '' });
  const [fresh, setFresh] = useState({
    name: '',
    price: '',
    cost: '',
    stock: '',
    low: '',
    supplier: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvInfo, setCsvInfo] = useState('');
  /** Task 464: "" = the stock CSV of all suppliers. */
  const [csvSupplier, setCsvSupplier] = useState('');
  const [stocktake, setStocktake] = useState(false);
  const [stocktakeDone, setStocktakeDone] = useState('');
  const money = (hundredths: number) => formatPrice(hundredths, salon.currency, props.locale);

  /** Task 461: "Sprzedano w 30 dni: 3 szt. · starczy na ~20 dni" — how fast it sells. */
  const pace = (x: Product): string | null => {
    const n = sold30.get(x.id);
    if (!n) return null;
    const days =
      x.stockQuantity !== null && x.stockQuantity > 0
        ? Math.floor((x.stockQuantity * 30) / n)
        : null;
    return [
      fill(p.sold30, { n: String(n) }),
      days === null ? '' : fill(p.lastsDays, { days: String(days) }),
    ]
      .filter(Boolean)
      .join(' · ');
  };

  const load = useCallback(async () => {
    try {
      const list = await api.products(salon.orgId, salon.locationId);
      setSold30(new Map(list.sold30Days.map((x) => [x.productId, x.quantity])));
      setProducts(list.products);
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
      if (history) {
        // The open history shows the change too (gone with a removed product).
        const res = await api
          .stockHistory(salon.orgId, salon.locationId, history.id)
          .catch(() => null);
        setHistory(res ? { id: history.id, rows: res.movements } : null);
      }
      return true;
    } catch (e) {
      setError(errorText(e, t));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const downloadCsv = async () => {
    if (csvBusy) return;
    setCsvBusy(true);
    setCsvInfo('');
    try {
      const file = await api.stockCsv(salon.orgId, salon.locationId, props.locale, csvFor || null);
      const result = await shareCsv(file, csvTools());
      setCsvInfo(result === 'failed' ? p.stockCsvFailed : '');
    } catch (e) {
      setCsvInfo(errorText(e, t));
    } finally {
      setCsvBusy(false);
    }
  };

  const draftPrice = parseAmount(draft.price);
  const freshPrice = parseAmount(fresh.price);
  const draftCost = parseCost(draft.cost);
  const freshCost = parseCost(fresh.cost);
  const draftStock = parseStock(draft.stock);
  const freshStock = parseStock(fresh.stock);
  const draftLow = parseStock(draft.low);
  const freshLow = parseStock(fresh.low);
  const toggleHistory = async (id: string) => {
    if (history?.id === id) {
      setHistory(null);
      return;
    }
    setError('');
    try {
      const res = await api.stockHistory(salon.orgId, salon.locationId, id);
      setHistory({ id, rows: res.movements });
    } catch (e) {
      setError(errorText(e, t));
    }
  };

  const deliveryCount = parseStock(delivery);
  const writeOffCount = parseStock(writeOff.quantity);
  const counted = (products ?? []).filter((x) => x.stockQuantity !== null);
  const stockPieces = counted.reduce((n, x) => n + (x.stockQuantity ?? 0), 0);
  const stockValue = counted.reduce((sum, x) => sum + (x.stockQuantity ?? 0) * x.priceGrosze, 0);
  // Task 448: at purchase prices — only when every counted product has one.
  const stockCost = counted.every((x) => x.purchasePriceGrosze !== null)
    ? counted.reduce((sum, x) => sum + (x.stockQuantity ?? 0) * (x.purchasePriceGrosze ?? 0), 0)
    : null;
  /** Task 464: the suppliers written at the products, each once (any letter case), by name. */
  const suppliers = [
    ...new Map(
      (products ?? [])
        .filter((x) => x.supplier !== null)
        .map((x) => [x.supplier!.toLocaleLowerCase(), x.supplier!]),
    ).values(),
  ].sort((a, b) => a.localeCompare(b));
  const csvFor = suppliers.includes(csvSupplier) ? csvSupplier : '';
  const toOrder = (products ?? []).filter((x) => x.active && (x.lowStock || x.stockQuantity === 0));

  return (
    <View style={{ gap: 8 }} testID="products">
      <Text role="heading" aria-level={2} style={styles.section}>
        {p.title}
      </Text>
      <Text style={styles.muted}>{p.listHint}</Text>
      <Text style={styles.muted}>{p.costHint}</Text>
      <Text style={styles.muted}>{p.supplierHint}</Text>
      {toOrder.length > 0 ? (
        <Text style={styles.warn} role="status" testID="products-to-order">
          {fill(p.toOrder, {
            names: toOrderNames(
              toOrder,
              (x) =>
                x.stockQuantity === 0
                  ? p.stockNone
                  : fill(p.stockLeft, { n: String(x.stockQuantity) }),
              p.toOrderNoSupplier,
            ),
          })}
        </Text>
      ) : null}
      {counted.length > 0 ? (
        <Text style={styles.text} testID="products-stock-value">
          {fill(p.stockValue, { amount: money(stockValue), n: String(stockPieces) })}
          {stockCost !== null ? ` ${fill(p.stockCostValue, { amount: money(stockCost) })}` : ''}
        </Text>
      ) : null}
      {products && products.length === 0 ? <Text style={styles.muted}>{p.empty}</Text> : null}
      {products && products.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Button
            kind="secondary"
            label={csvBusy ? t.loading : p.stockCsv}
            onPress={() => void downloadCsv()}
          />
          <Text style={styles.muted}>{p.stockCsvHint}</Text>
          {suppliers.length > 0 ? (
            <View style={styles.row} testID="stock-csv-supplier">
              <Text style={styles.muted}>{`${p.supplierCsv}:`}</Text>
              {['', ...suppliers].map((name) => (
                <Button
                  key={name || '*'}
                  kind={csvFor === name ? 'primary' : 'secondary'}
                  label={name || p.supplierAll}
                  a11yLabel={`${p.supplierCsv}: ${name || p.supplierAll}`}
                  onPress={() => setCsvSupplier(name)}
                />
              ))}
            </View>
          ) : null}
          {csvInfo ? <Text style={styles.warn}>{csvInfo}</Text> : null}
          <Button
            kind="secondary"
            label={p.stocktake}
            onPress={() => {
              setStocktake(!stocktake);
              setStocktakeDone('');
            }}
          />
        </View>
      ) : null}
      {stocktakeDone ? (
        <Text style={styles.text} role="status" testID="stocktake-done">
          {stocktakeDone}
        </Text>
      ) : null}
      {stocktake && products && products.length > 0 ? (
        <StocktakeCard
          api={api}
          t={t}
          salon={salon}
          products={products}
          onSaved={(result) => {
            setProducts(result.products);
            setStocktake(false);
            setHistory(null);
            setStocktakeDone(
              fill(p.stocktakeDone, {
                changed: String(result.changed),
                missing: String(result.missingPieces),
                extra: String(result.extraPieces),
              }),
            );
          }}
        />
      ) : null}
      {(products ?? []).map((x) =>
        editId === x.id ? (
          <Card key={x.id}>
            <TextInput
              accessibilityLabel={p.name}
              value={draft.name}
              maxLength={80}
              onChangeText={(name) => setDraft({ ...draft, name })}
              style={styles.input}
            />
            <TextInput
              accessibilityLabel={fill(p.priceIn, { currency: salon.currency })}
              keyboardType="decimal-pad"
              value={draft.price}
              onChangeText={(price) => setDraft({ ...draft, price })}
              style={[styles.input, { marginTop: 8 }]}
            />
            {draftPrice === null ? <Text style={styles.warn}>{p.priceInvalid}</Text> : null}
            <TextInput
              accessibilityLabel={`${p.costNew} (${salon.currency})`}
              placeholder={`${p.costNew} (${salon.currency})`}
              placeholderTextColor={colors.placeholder}
              keyboardType="decimal-pad"
              value={draft.cost}
              onChangeText={(cost) => setDraft({ ...draft, cost })}
              style={[styles.input, { marginTop: 8 }]}
            />
            {draftCost === undefined ? <Text style={styles.warn}>{p.priceInvalid}</Text> : null}
            <TextInput
              accessibilityLabel={p.supplierNew}
              placeholder={p.supplierNew}
              placeholderTextColor={colors.placeholder}
              value={draft.supplier}
              maxLength={80}
              onChangeText={(supplier) => setDraft({ ...draft, supplier })}
              style={[styles.input, { marginTop: 8 }]}
            />
            <TextInput
              accessibilityLabel={p.stockIn}
              placeholder={p.stockIn}
              placeholderTextColor={colors.placeholder}
              keyboardType="number-pad"
              value={draft.stock}
              onChangeText={(stock) => setDraft({ ...draft, stock })}
              style={[styles.input, { marginTop: 8 }]}
            />
            {draftStock === undefined ? <Text style={styles.warn}>{p.stockInvalid}</Text> : null}
            <TextInput
              accessibilityLabel={p.lowIn}
              placeholder={p.lowIn}
              placeholderTextColor={colors.placeholder}
              keyboardType="number-pad"
              value={draft.low}
              onChangeText={(low) => setDraft({ ...draft, low })}
              style={[styles.input, { marginTop: 8 }]}
            />
            {draftLow === undefined ? <Text style={styles.warn}>{p.stockInvalid}</Text> : null}
            <View style={styles.row}>
              <Button
                label={p.save}
                busy={busy}
                disabled={
                  draftPrice === null ||
                  draftCost === undefined ||
                  draftStock === undefined ||
                  draftLow === undefined ||
                  draft.name.trim() === ''
                }
                onPress={() =>
                  void run(() =>
                    api.updateProduct(salon.orgId, salon.locationId, x.id, {
                      name: draft.name.trim(),
                      priceGrosze: draftPrice ?? x.priceGrosze,
                      purchasePriceGrosze: draftCost ?? null,
                      stockQuantity: draftStock ?? null,
                      lowStockAt: draftLow ?? null,
                      supplier: draft.supplier.trim() || null,
                    }),
                  ).then((ok) => ok && setEditId(null))
                }
              />
              <Button kind="secondary" label={p.cancel} onPress={() => setEditId(null)} />
            </View>
          </Card>
        ) : (
          <Card key={x.id}>
            <View style={styles.top}>
              <Text style={[styles.name, !x.active && { color: colors.muted }]}>{x.name}</Text>
              <Text style={styles.name}>{money(x.priceGrosze)}</Text>
            </View>
            {x.active ? null : <Text style={styles.muted}>{p.notSold}</Text>}
            {x.purchasePriceGrosze === null ? null : (
              <Text style={styles.muted} testID="product-cost">
                {`${p.cost}: ${money(x.purchasePriceGrosze)}`}
              </Text>
            )}
            {x.supplier === null ? null : (
              <Text style={styles.muted} testID="product-supplier">
                {`${p.supplier}: ${x.supplier}`}
              </Text>
            )}
            {x.stockQuantity === null ? null : x.stockQuantity > 0 ? (
              <Text style={x.lowStock ? styles.warn : styles.muted}>
                {fill(p.stockLeft, { n: String(x.stockQuantity) })}
                {x.lowStock ? ` · ${p.lowBadge}` : ''}
              </Text>
            ) : (
              <Text style={styles.warn}>{p.stockNone}</Text>
            )}
            {pace(x) ? (
              <Text style={styles.muted} testID="product-pace">
                {pace(x)}
              </Text>
            ) : null}
            {deliveryId === x.id ? (
              <View style={{ gap: 6, marginTop: 6 }}>
                <TextInput
                  accessibilityLabel={fill(p.restockFor, { name: x.name })}
                  placeholder={p.restockIn}
                  placeholderTextColor={colors.placeholder}
                  keyboardType="number-pad"
                  value={delivery}
                  onChangeText={setDelivery}
                  style={styles.input}
                />
                <View style={styles.row}>
                  <Button
                    label={p.restockAdd}
                    busy={busy}
                    disabled={!deliveryCount}
                    onPress={() =>
                      void run(() =>
                        api.restockProduct(salon.orgId, salon.locationId, x.id, deliveryCount ?? 0),
                      ).then((ok) => ok && setDeliveryId(null))
                    }
                  />
                  <Button kind="secondary" label={p.cancel} onPress={() => setDeliveryId(null)} />
                </View>
              </View>
            ) : writeOffId === x.id ? (
              // Task 445: "Odpis" — used in the salon, damaged or lost.
              <View style={{ gap: 6, marginTop: 6 }}>
                <TextInput
                  accessibilityLabel={fill(p.writeOffFor, { name: x.name })}
                  placeholder={p.writeOffQuantity}
                  placeholderTextColor={colors.placeholder}
                  keyboardType="number-pad"
                  value={writeOff.quantity}
                  onChangeText={(quantity) => setWriteOff({ ...writeOff, quantity })}
                  style={styles.input}
                />
                <TextInput
                  accessibilityLabel={p.writeOffNote}
                  placeholder={p.writeOffNote}
                  placeholderTextColor={colors.placeholder}
                  maxLength={120}
                  value={writeOff.note}
                  onChangeText={(note) => setWriteOff({ ...writeOff, note })}
                  style={styles.input}
                />
                <View style={styles.row}>
                  <Button
                    label={p.writeOffAdd}
                    busy={busy}
                    disabled={!writeOffCount}
                    onPress={() =>
                      void run(() =>
                        api.writeOffProduct(
                          salon.orgId,
                          salon.locationId,
                          x.id,
                          writeOffCount ?? 0,
                          writeOff.note.trim() || undefined,
                        ),
                      ).then((ok) => ok && setWriteOffId(null))
                    }
                  />
                  <Button kind="secondary" label={p.cancel} onPress={() => setWriteOffId(null)} />
                </View>
              </View>
            ) : askRemove === x.id ? (
              <View style={{ gap: 6, marginTop: 6 }}>
                <Text style={styles.text}>{fill(p.removeAsk, { name: x.name })}</Text>
                <View style={styles.row}>
                  <Button
                    label={p.removeYes}
                    busy={busy}
                    onPress={() =>
                      void run(() => api.removeProduct(salon.orgId, salon.locationId, x.id)).then(
                        () => setAskRemove(null),
                      )
                    }
                  />
                  <Button kind="secondary" label={p.cancel} onPress={() => setAskRemove(null)} />
                </View>
              </View>
            ) : (
              <View style={styles.row}>
                <Button
                  kind="secondary"
                  label={p.history}
                  a11yLabel={fill(p.historyFor, { name: x.name })}
                  onPress={() => void toggleHistory(x.id)}
                />
                <Button
                  kind="secondary"
                  label={p.restock}
                  a11yLabel={fill(p.restockFor, { name: x.name })}
                  disabled={busy}
                  onPress={() => {
                    setDelivery('');
                    setAskRemove(null);
                    setWriteOffId(null);
                    setDeliveryId(x.id);
                  }}
                />
                {x.stockQuantity !== null && x.stockQuantity > 0 ? (
                  <Button
                    kind="secondary"
                    label={p.writeOff}
                    a11yLabel={fill(p.writeOffFor, { name: x.name })}
                    disabled={busy}
                    onPress={() => {
                      setWriteOff({ quantity: '', note: '' });
                      setAskRemove(null);
                      setDeliveryId(null);
                      setWriteOffId(x.id);
                    }}
                  />
                ) : null}
                <Button
                  kind="secondary"
                  label={p.change}
                  a11yLabel={fill(p.changeFor, { name: x.name })}
                  onPress={() => {
                    setDraft({
                      name: x.name,
                      price: amountInput(x.priceGrosze) || '0',
                      cost:
                        x.purchasePriceGrosze === null
                          ? ''
                          : amountInput(x.purchasePriceGrosze) || '0',
                      stock: x.stockQuantity === null ? '' : String(x.stockQuantity),
                      low: x.lowStockAt === null ? '' : String(x.lowStockAt),
                      supplier: x.supplier ?? '',
                    });
                    setEditId(x.id);
                  }}
                />
                <Button
                  kind="secondary"
                  label={x.active ? p.stopSelling : p.startSelling}
                  disabled={busy}
                  onPress={() =>
                    void run(() =>
                      api.updateProduct(salon.orgId, salon.locationId, x.id, {
                        active: !x.active,
                      }),
                    )
                  }
                />
                <Button
                  kind="link"
                  label={p.remove}
                  a11yLabel={fill(p.removeFor, { name: x.name })}
                  onPress={() => setAskRemove(x.id)}
                />
              </View>
            )}
            {history?.id === x.id ? (
              <View style={{ gap: 4, marginTop: 8 }} testID="stock-history">
                <Text style={styles.text}>{fill(p.historyFor, { name: x.name })}</Text>
                {history.rows.length === 0 ? (
                  <Text style={styles.muted}>{p.historyEmpty}</Text>
                ) : (
                  history.rows.map((r) => (
                    <Text key={r.id} style={styles.muted}>
                      {`${r.date} ${r.time} · ${p.historyKinds[r.kind]} · ${fill(p.historyRow, {
                        change: r.change > 0 ? `+${r.change}` : String(r.change),
                        after:
                          r.quantityAfter === null ? p.historyNotCounted : String(r.quantityAfter),
                      })}${r.byName ? ` · ${r.byName}` : ''}${r.note ? ` · ${r.note}` : ''}`}
                    </Text>
                  ))
                )}
              </View>
            ) : null}
          </Card>
        ),
      )}
      <TextInput
        accessibilityLabel={p.newName}
        placeholder={p.newName}
        placeholderTextColor={colors.placeholder}
        value={fresh.name}
        maxLength={80}
        onChangeText={(name) => setFresh({ ...fresh, name })}
        style={styles.input}
      />
      <TextInput
        accessibilityLabel={fill(p.priceIn, { currency: salon.currency })}
        placeholder={fill(p.priceIn, { currency: salon.currency })}
        placeholderTextColor={colors.placeholder}
        keyboardType="decimal-pad"
        value={fresh.price}
        onChangeText={(price) => setFresh({ ...fresh, price })}
        style={styles.input}
      />
      <TextInput
        accessibilityLabel={`${p.costNew} (${salon.currency})`}
        placeholder={`${p.costNew} (${salon.currency})`}
        placeholderTextColor={colors.placeholder}
        keyboardType="decimal-pad"
        value={fresh.cost}
        onChangeText={(cost) => setFresh({ ...fresh, cost })}
        style={styles.input}
      />
      {freshCost === undefined ? <Text style={styles.warn}>{p.priceInvalid}</Text> : null}
      <TextInput
        accessibilityLabel={p.supplierNew}
        placeholder={p.supplierNew}
        placeholderTextColor={colors.placeholder}
        value={fresh.supplier}
        maxLength={80}
        onChangeText={(supplier) => setFresh({ ...fresh, supplier })}
        style={styles.input}
      />
      <TextInput
        accessibilityLabel={p.stockIn}
        placeholder={p.stockIn}
        placeholderTextColor={colors.placeholder}
        keyboardType="number-pad"
        value={fresh.stock}
        onChangeText={(stock) => setFresh({ ...fresh, stock })}
        style={styles.input}
      />
      {freshStock === undefined ? <Text style={styles.warn}>{p.stockInvalid}</Text> : null}
      <TextInput
        accessibilityLabel={p.lowIn}
        placeholder={p.lowIn}
        placeholderTextColor={colors.placeholder}
        keyboardType="number-pad"
        value={fresh.low}
        onChangeText={(low) => setFresh({ ...fresh, low })}
        style={styles.input}
      />
      {freshLow === undefined ? <Text style={styles.warn}>{p.stockInvalid}</Text> : null}
      <View style={styles.row}>
        <Button
          label={p.add}
          busy={busy}
          disabled={
            fresh.name.trim() === '' ||
            fresh.price.trim() === '' ||
            freshPrice === null ||
            freshCost === undefined ||
            freshStock === undefined ||
            freshLow === undefined
          }
          onPress={() =>
            void run(() =>
              api.addProduct(
                salon.orgId,
                salon.locationId,
                fresh.name.trim(),
                freshPrice ?? 0,
                freshStock ?? null,
                freshLow ?? null,
                freshCost ?? null,
                fresh.supplier.trim() || null,
              ),
            ).then(
              (ok) =>
                ok && setFresh({ name: '', price: '', cost: '', stock: '', low: '', supplier: '' }),
            )
          }
        />
      </View>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 18, fontWeight: '700', color: colors.ink, marginTop: 8 },
  top: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 },
  name: { fontSize: 16, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  text: { fontSize: 15, color: colors.ink },
  muted: { color: colors.muted, fontSize: 14 },
  warn: { color: colors.danger, fontSize: 14 },
  input: {
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
