import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Locale, Product, StockHistory } from '../api';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { shareCsv } from '../share';
import { parseStock } from '../stock';
import { parseTip as parseAmount, tipInput as amountInput } from '../tip';
import { Button, Card, colors, ErrorText } from '../ui';
import { csvTools } from './csvTools';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 397: "Produkty" in "Usługi" of the business app — the salon's list of products sold at
 * a visit, as in the cabinet (task 395): add, change the name or price, «Nie sprzedajemy» /
 * «Sprzedajemy», remove (with a question; past sales stay in the reports).
 * Task 431: "W magazynie" — pieces in stock (empty = not counted), as in the cabinet (430).
 * Task 435: "Kończy się przy" — the salon's own number of pieces that is already few; such
 * products say "Kończy się" and are listed in "Do zamówienia", as in the cabinet (434).
 * Task 441: "Historia" — the product's last stock changes (sale, delivery, by hand), who and when.
 * Task 439: "Dostawa" — how many pieces arrived; the server adds them to the stock.
 * Task 437: "CSV stanu magazynowego" — the list as a file for the supplier (shared on a phone,
 * saved in a browser).
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
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', price: '', stock: '', low: '' });
  const [askRemove, setAskRemove] = useState<string | null>(null);
  const [history, setHistory] = useState<{
    id: string;
    rows: StockHistory['movements'];
  } | null>(null);
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [delivery, setDelivery] = useState('');
  const [fresh, setFresh] = useState({ name: '', price: '', stock: '', low: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvInfo, setCsvInfo] = useState('');
  const money = (hundredths: number) => formatPrice(hundredths, salon.currency, props.locale);

  const load = useCallback(async () => {
    try {
      setProducts((await api.products(salon.orgId, salon.locationId)).products);
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
      const file = await api.stockCsv(salon.orgId, salon.locationId, props.locale);
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
  const toOrder = (products ?? []).filter((x) => x.active && (x.lowStock || x.stockQuantity === 0));

  return (
    <View style={{ gap: 8 }} testID="products">
      <Text role="heading" aria-level={2} style={styles.section}>
        {p.title}
      </Text>
      <Text style={styles.muted}>{p.listHint}</Text>
      {toOrder.length > 0 ? (
        <Text style={styles.warn} role="status" testID="products-to-order">
          {fill(p.toOrder, {
            names: toOrder
              .map(
                (x) =>
                  `${x.name} (${
                    x.stockQuantity === 0
                      ? p.stockNone
                      : fill(p.stockLeft, { n: String(x.stockQuantity) })
                  })`,
              )
              .join(', '),
          })}
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
          {csvInfo ? <Text style={styles.warn}>{csvInfo}</Text> : null}
        </View>
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
                  draftStock === undefined ||
                  draftLow === undefined ||
                  draft.name.trim() === ''
                }
                onPress={() =>
                  void run(() =>
                    api.updateProduct(salon.orgId, salon.locationId, x.id, {
                      name: draft.name.trim(),
                      priceGrosze: draftPrice ?? x.priceGrosze,
                      stockQuantity: draftStock ?? null,
                      lowStockAt: draftLow ?? null,
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
            {x.stockQuantity === null ? null : x.stockQuantity > 0 ? (
              <Text style={x.lowStock ? styles.warn : styles.muted}>
                {fill(p.stockLeft, { n: String(x.stockQuantity) })}
                {x.lowStock ? ` · ${p.lowBadge}` : ''}
              </Text>
            ) : (
              <Text style={styles.warn}>{p.stockNone}</Text>
            )}
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
                    setDeliveryId(x.id);
                  }}
                />
                <Button
                  kind="secondary"
                  label={p.change}
                  a11yLabel={fill(p.changeFor, { name: x.name })}
                  onPress={() => {
                    setDraft({
                      name: x.name,
                      price: amountInput(x.priceGrosze) || '0',
                      stock: x.stockQuantity === null ? '' : String(x.stockQuantity),
                      low: x.lowStockAt === null ? '' : String(x.lowStockAt),
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
                      })}${r.byName ? ` · ${r.byName}` : ''}`}
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
              ),
            ).then((ok) => ok && setFresh({ name: '', price: '', stock: '', low: '' }))
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
