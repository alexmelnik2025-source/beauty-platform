import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ClientApi, Locale, ShopCategory, ShopProduct } from '../api';
import { API_URL } from '../config';
import { errorText } from '../errors';
import { formatPrice } from '../format';
import { fill, type Dictionary } from '../i18n';
import { fromCurrency, SHOP_CATEGORIES, sellersLine } from '../shop';
import { Button, Card, Chip, colors, ErrorText, Heading } from '../ui';

/** The search asks the server once the client stops typing for this long. */
const TYPING_MS = 350;

const photoUri = (id: string) => `${API_URL}/v1/public/photos/${encodeURIComponent(id)}`;

/**
 * Task Q3 (screen 2): "Sklep" — products the salons sell online, with a search and categories.
 * A product shows the salons that have it; at the launch each one is picked up and paid at the
 * salon (no online payment, no shipping). "Umów wizytę" opens that salon to book a visit.
 * Kept minimal: one list, one search field, the categories as quiet chips.
 */
export function ShopScreen(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  onBack: () => void;
  /** "Umów wizytę" at an offer: the salon's page with its booking. */
  onOpenSalon: (salon: { slug: string; name: string }) => void;
}) {
  const { api, t, locale } = props;
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ShopCategory | null>(null);
  const [items, setItems] = useState<ShopProduct[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<ShopProduct | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(
    async (nextPage: number, append: boolean) => {
      setBusy(true);
      setError('');
      try {
        const res = await api.shop({
          q: search || undefined,
          category: category ?? undefined,
          page: nextPage,
        });
        setItems((old) => (append ? [...old, ...res.products] : res.products));
        setPage(res.page);
        setTotal(res.total);
      } catch (e) {
        setError(errorText(e, tRef.current));
      } finally {
        setBusy(false);
      }
    },
    [api, search, category],
  );

  useEffect(() => {
    void load(1, false);
  }, [load]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), TYPING_MS);
    return () => clearTimeout(timer);
  }, [query]);

  if (open) {
    return (
      <ProductView
        product={open}
        t={t}
        locale={locale}
        onBack={() => setOpen(null)}
        onOpenSalon={props.onOpenSalon}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.top}>
        <Button kind="link" label={t.salon.back} onPress={props.onBack} />
      </View>
      <Heading>{t.shop.title}</Heading>
      <Text style={styles.text}>{t.shop.lead}</Text>
      <TextInput
        accessibilityLabel={t.shop.search}
        placeholder={t.shop.search}
        placeholderTextColor={colors.placeholder}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        inputMode="search"
        onSubmitEditing={() => setSearch(query.trim())}
        style={styles.input}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        accessibilityLabel={t.shop.categoriesLabel}
      >
        <Chip label={t.shop.all} pressed={category === null} onPress={() => setCategory(null)} />
        {SHOP_CATEGORIES.map((c) => (
          <Chip
            key={c}
            label={t.shop.categories[c]}
            pressed={category === c}
            onPress={() => setCategory(category === c ? null : c)}
          />
        ))}
      </ScrollView>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {!busy && !error && items.length === 0 ? (
        <Text style={styles.text}>{search || category ? t.shop.noMatch : t.shop.empty}</Text>
      ) : null}
      {items.map((p) => {
        const sellers = sellersLine(p);
        const price = formatPrice(p.fromPriceGrosze, fromCurrency(p), locale);
        return (
          <Pressable
            key={p.id}
            accessibilityRole="button"
            accessibilityLabel={`${p.name}, ${fill(t.shop.from, { price })}`}
            onPress={() => setOpen(p)}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
          >
            {p.photoId ? (
              <Image source={{ uri: photoUri(p.photoId) }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.noPhoto]} />
            )}
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.name} numberOfLines={2}>
                {p.name}
              </Text>
              {p.brand ? <Text style={styles.small}>{p.brand}</Text> : null}
              <Text style={styles.price}>{fill(t.shop.from, { price })}</Text>
              <Text style={styles.small} numberOfLines={1}>
                {sellers === null
                  ? t.shop.soldOut
                  : sellers.kind === 'one'
                    ? sellers.salon
                    : fill(t.shop.salons, { n: String(sellers.n) })}
              </Text>
            </View>
          </Pressable>
        );
      })}
      {busy ? <ActivityIndicator style={{ marginTop: 16 }} color={colors.ink} /> : null}
      {!busy && !error && items.length < total ? (
        <Button kind="secondary" label={t.shop.more} onPress={() => void load(page + 1, true)} />
      ) : null}
    </ScrollView>
  );
}

/** One product: its picture and description, and the salons where the client picks it up. */
function ProductView(props: {
  product: ShopProduct;
  t: Dictionary;
  locale: Locale;
  onBack: () => void;
  onOpenSalon: (salon: { slug: string; name: string }) => void;
}) {
  const { product: p, t, locale } = props;
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.top}>
        <Button kind="link" label={t.shop.backToShop} onPress={props.onBack} />
      </View>
      {p.photoId ? (
        <Image
          source={{ uri: photoUri(p.photoId) }}
          style={styles.photo}
          accessibilityLabel={p.name}
        />
      ) : null}
      <Heading>{p.name}</Heading>
      {p.brand ? <Text style={styles.text}>{p.brand}</Text> : null}
      {p.description ? <Text style={styles.body}>{p.description}</Text> : null}
      <Text role="heading" aria-level={2} style={styles.subheading}>
        {t.shop.where}
      </Text>
      <Text style={styles.small}>{t.shop.pickup}</Text>
      {p.offers.map((o) => (
        <Card key={o.productId}>
          <View style={styles.offerTop}>
            <Text style={[styles.name, { flex: 1 }]}>{o.salon.name}</Text>
            <Text style={styles.price}>{formatPrice(o.priceGrosze, o.currency, locale)}</Text>
          </View>
          <Text style={styles.small}>
            {[o.salon.addressLine, o.salon.city].filter(Boolean).join(', ')}
          </Text>
          {o.available ? null : <Text style={styles.small}>{t.shop.soldOut}</Text>}
          <View style={{ marginTop: 8 }}>
            <Button
              kind="secondary"
              label={t.shop.book}
              a11yLabel={`${t.shop.book}: ${o.salon.name}`}
              onPress={() => props.onOpenSalon({ slug: o.salon.slug, name: o.salon.name })}
            />
          </View>
        </Card>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 14 },
  top: { flexDirection: 'row', marginLeft: -8 },
  text: { color: colors.muted, fontSize: 15, lineHeight: 21 },
  body: { color: colors.ink, fontSize: 16, lineHeight: 23 },
  small: { color: colors.muted, fontSize: 14 },
  price: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  name: { fontSize: 17, fontWeight: '700', color: colors.ink },
  subheading: { fontSize: 18, fontWeight: '700', color: colors.ink, marginTop: 8 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.ink,
  },
  chips: { flexDirection: 'row', gap: 8, paddingVertical: 2 },
  row: {
    flexDirection: 'row',
    gap: 14,
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 12,
  },
  thumb: { width: 72, height: 72, borderRadius: 10 },
  noPhoto: { backgroundColor: colors.soft },
  photo: { width: '100%', aspectRatio: 1, borderRadius: 14, backgroundColor: colors.soft },
  offerTop: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
});
