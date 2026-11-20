import { useCallback, useEffect, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type BusinessApi, type CatalogProduct, type Locale, type Product } from '../api';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { parseStock } from '../stock';
import { parseTip as parseAmount } from '../tip';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task Q3 (part 2c): "Mój sklep" in the business app — the same as in the cabinet (part 2a).
 * Every product of the salon with two switches: "Pokaż klientom na stronie salonu" and
 * "Sprzedawaj też w Sklepie" (needs a card in the platform catalogue: "Wybierz z katalogu" finds
 * one by words or EAN, "Nowa karta" makes one from the product's name). A quick "Dodaj produkt"
 * adds a product already shown to clients. Nothing about shipping at the launch. Pictures of the
 * cards are added in the cabinet.
 */
export function MyShopScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const s = t.shop;
  const [products, setProducts] = useState<Product[] | null>(null);
  const [cards, setCards] = useState<Record<string, CatalogProduct>>({});
  const [picking, setPicking] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<CatalogProduct[] | null>(null);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const list = await api.products(salon.orgId, salon.locationId);
    setProducts(list.products.filter((p) => p.active));
    const ids = [...new Set(list.products.map((p) => p.catalogProductId).filter(Boolean))];
    const got = await Promise.all(
      ids.map((id) =>
        api.catalogCard(salon.orgId, salon.locationId, id as string).catch(() => null),
      ),
    );
    setCards(
      Object.fromEntries(got.filter((c): c is CatalogProduct => c !== null).map((c) => [c.id, c])),
    );
  }, [api, salon]);

  useEffect(() => {
    load().catch((e: unknown) => setError(errorText(e, t)));
  }, [load, t]);

  // Android's back button closes the screen instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (e) {
      // A card with this EAN exists: the salon picks it from the list instead.
      setError(e instanceof ApiError && e.code === 'EAN_TAKEN' ? s.eanTaken : errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const patch = (
    id: string,
    changes: { catalogProductId?: string | null; inSalonShop?: boolean; inMarketplace?: boolean },
  ) => run(() => api.updateProduct(salon.orgId, salon.locationId, id, changes));

  const search = async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) {
      setFound(null);
      return;
    }
    try {
      setFound((await api.catalogSearch(salon.orgId, salon.locationId, q.trim())).products);
    } catch (e) {
      setError(errorText(e, t));
    }
  };

  const add = () => {
    const priceGrosze = parseAmount(price);
    const stockQuantity = parseStock(stock);
    if (!name.trim() || priceGrosze === null || stockQuantity === undefined) {
      setError(s.addInvalid);
      return;
    }
    void run(async () => {
      await api.addProduct(
        salon.orgId,
        salon.locationId,
        name.trim(),
        priceGrosze,
        stockQuantity,
        null,
        null,
        null,
        null,
        true,
      );
      setName('');
      setPrice('');
      setStock('');
    });
  };

  const shown = products ?? [];
  const inShop = shown.filter((p) => p.inSalonShop).length;

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Button kind="link" label={s.back} onPress={onBack} />
      <Heading>{s.title}</Heading>
      <Text style={styles.muted}>{s.hint}</Text>
      <Text style={styles.muted}>{s.pickupOnly}</Text>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {products ? (
        <Text style={styles.summary}>
          {fill(s.summary, { shown: String(inShop), all: String(shown.length) })}
        </Text>
      ) : (
        <Text style={styles.muted}>{t.loading}</Text>
      )}
      {products && shown.length === 0 ? <Text style={styles.muted}>{s.empty}</Text> : null}

      {shown.map((x) => {
        const card = x.catalogProductId ? cards[x.catalogProductId] : undefined;
        const canMarket = x.inSalonShop && Boolean(x.catalogProductId);
        return (
          <Card key={x.id}>
            <View style={styles.titleRow}>
              <Text style={styles.name}>{x.name}</Text>
              <Text style={styles.muted}>
                {formatPrice(x.priceGrosze, salon.currency, props.locale)}
                {x.stockQuantity !== null
                  ? ` · ${fill(s.pieces, { n: String(x.stockQuantity) })}`
                  : ''}
              </Text>
            </View>
            <Button
              kind={x.inSalonShop ? 'secondary' : 'primary'}
              label={x.inSalonShop ? s.hideFromSalon : s.showInSalon}
              disabled={busy}
              onPress={() =>
                void patch(x.id, {
                  inSalonShop: !x.inSalonShop,
                  ...(x.inSalonShop ? { inMarketplace: false } : {}),
                })
              }
            />
            {canMarket ? (
              <Button
                kind="secondary"
                label={x.inMarketplace ? s.stopMarketplace : s.startMarketplace}
                disabled={busy}
                onPress={() => void patch(x.id, { inMarketplace: !x.inMarketplace })}
              />
            ) : (
              <Text style={styles.small}>
                {!x.inSalonShop ? s.marketNeedsSalonShop : s.marketNeedsCard}
              </Text>
            )}
            {card ? (
              <View style={styles.cardRow}>
                <Text style={styles.small}>
                  {s.card}: {card.name}
                  {card.brand ? ` · ${card.brand}` : ''}
                  {card.ean ? ` · EAN ${card.ean}` : ''}
                  {card.sellers > 1 ? ` · ${fill(s.sellers, { n: String(card.sellers) })}` : ''}
                </Text>
                <Button
                  kind="link"
                  label={s.unlink}
                  disabled={busy}
                  onPress={() => void patch(x.id, { catalogProductId: null, inMarketplace: false })}
                />
              </View>
            ) : (
              <View style={styles.cardRow}>
                <Text style={styles.small}>{s.noCard}</Text>
                <Button
                  kind="link"
                  label={picking === x.id ? s.pickClose : s.pick}
                  disabled={busy}
                  onPress={() => {
                    if (picking === x.id) {
                      setPicking(null);
                      return;
                    }
                    setPicking(x.id);
                    setFound(null);
                    void search(x.barcode ?? x.name);
                  }}
                />
              </View>
            )}
            {picking === x.id ? (
              <View style={styles.picker}>
                <Text style={styles.label}>{s.search}</Text>
                <TextInput
                  accessibilityLabel={s.search}
                  value={query}
                  onChangeText={(v) => void search(v)}
                  style={styles.input}
                  autoFocus
                />
                {found && found.length > 0 ? (
                  found.map((c) => (
                    <View key={c.id} style={styles.foundRow}>
                      <Text style={styles.small}>
                        {c.name}
                        {c.brand ? ` · ${c.brand}` : ''}
                        {c.ean ? ` · EAN ${c.ean}` : ''}
                        {c.sellers > 0 ? ` · ${fill(s.sellers, { n: String(c.sellers) })}` : ''}
                      </Text>
                      <Button
                        kind="secondary"
                        label={s.choose}
                        a11yLabel={fill(s.chooseCard, { name: c.name })}
                        disabled={busy}
                        onPress={() =>
                          void run(async () => {
                            await api.updateProduct(salon.orgId, salon.locationId, x.id, {
                              catalogProductId: c.id,
                            });
                            setPicking(null);
                          })
                        }
                      />
                    </View>
                  ))
                ) : found ? (
                  <Text style={styles.small}>{s.nothingFound}</Text>
                ) : null}
                <Button
                  kind="secondary"
                  label={fill(s.newCard, { name: x.name })}
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      const made = await api.createCatalogCard(salon.orgId, salon.locationId, {
                        name: x.name,
                        ean: x.barcode && /^\d{8,14}$/.test(x.barcode) ? x.barcode : null,
                      });
                      await api.updateProduct(salon.orgId, salon.locationId, x.id, {
                        catalogProductId: made.id,
                      });
                      setPicking(null);
                    })
                  }
                />
              </View>
            ) : null}
          </Card>
        );
      })}

      <Card>
        <Text style={styles.name}>{s.add}</Text>
        <Text style={styles.small}>{s.addHint}</Text>
        <Text style={styles.label}>{t.products.name}</Text>
        <TextInput
          accessibilityLabel={t.products.name}
          value={name}
          onChangeText={setName}
          style={styles.input}
          maxLength={80}
        />
        <Text style={styles.label}>{fill(t.products.priceIn, { currency: salon.currency })}</Text>
        <TextInput
          accessibilityLabel={fill(t.products.priceIn, { currency: salon.currency })}
          value={price}
          onChangeText={setPrice}
          keyboardType="decimal-pad"
          style={styles.input}
        />
        <Text style={styles.label}>{s.stock}</Text>
        <TextInput
          accessibilityLabel={s.stock}
          value={stock}
          onChangeText={setStock}
          keyboardType="number-pad"
          style={styles.input}
        />
        <Button label={s.add} busy={busy} onPress={add} />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 14 },
  summary: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  name: { fontSize: 17, fontWeight: '700', color: colors.ink },
  cardRow: { gap: 4 },
  picker: { gap: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 },
  foundRow: { gap: 6, paddingVertical: 4 },
  label: { fontSize: 14, color: colors.muted },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 10,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: colors.card,
  },
});
