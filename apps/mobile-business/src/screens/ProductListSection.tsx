import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Locale, Product } from '../api';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { parseTip as parseAmount, tipInput as amountInput } from '../tip';
import { Button, Card, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 397: "Produkty" in "Usługi" of the business app — the salon's list of products sold at
 * a visit, as in the cabinet (task 395): add, change the name or price, «Nie sprzedajemy» /
 * «Sprzedajemy», remove (with a question; past sales stay in the reports).
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
  const [draft, setDraft] = useState({ name: '', price: '' });
  const [askRemove, setAskRemove] = useState<string | null>(null);
  const [fresh, setFresh] = useState({ name: '', price: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
      return true;
    } catch (e) {
      setError(errorText(e, t));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const draftPrice = parseAmount(draft.price);
  const freshPrice = parseAmount(fresh.price);

  return (
    <View style={{ gap: 8 }} testID="products">
      <Text role="heading" aria-level={2} style={styles.section}>
        {p.title}
      </Text>
      <Text style={styles.muted}>{p.listHint}</Text>
      {products && products.length === 0 ? <Text style={styles.muted}>{p.empty}</Text> : null}
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
            <View style={styles.row}>
              <Button
                label={p.save}
                busy={busy}
                disabled={draftPrice === null || draft.name.trim() === ''}
                onPress={() =>
                  void run(() =>
                    api.updateProduct(salon.orgId, salon.locationId, x.id, {
                      name: draft.name.trim(),
                      priceGrosze: draftPrice ?? x.priceGrosze,
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
            {askRemove === x.id ? (
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
                  label={p.change}
                  a11yLabel={fill(p.changeFor, { name: x.name })}
                  onPress={() => {
                    setDraft({ name: x.name, price: amountInput(x.priceGrosze) || '0' });
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
      <View style={styles.row}>
        <Button
          label={p.add}
          busy={busy}
          disabled={fresh.name.trim() === '' || fresh.price.trim() === '' || freshPrice === null}
          onPress={() =>
            void run(() =>
              api.addProduct(salon.orgId, salon.locationId, fresh.name.trim(), freshPrice ?? 0),
            ).then((ok) => ok && setFresh({ name: '', price: '' }))
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
