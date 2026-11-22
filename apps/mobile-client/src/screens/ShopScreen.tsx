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
import type { ClientApi, ClientAppointment, Locale, ShopCategory, ShopProduct } from '../api';
import { API_URL } from '../config';
import { errorText } from '../errors';
import { formatMoment, formatPrice } from '../format';
import { fill, type Dictionary } from '../i18n';
import { fromCurrency, nextVisitAt, SHOP_CATEGORIES, sellersLine } from '../shop';
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
  /** Signed in: an offer at a salon where I have a visit ahead offers "Odbiorę przy wizycie". */
  signedIn: boolean;
  /** "Umów wizytę" at an offer: the salon's page with its booking. */
  onOpenSalon: (salon: { slug: string; name: string }) => void;
  /** "Zapisz się i odbierz": the salon's booking; the product is put aside once it is booked. */
  onBookWith: (salon: { slug: string; name: string }, productId: string) => void;
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
  const latest = useRef(0);
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(
    async (nextPage: number, append: boolean) => {
      const request = ++latest.current;
      setBusy(true);
      setError('');
      try {
        const res = await api.shop({
          q: search || undefined,
          category: category ?? undefined,
          page: nextPage,
        });
        if (request !== latest.current) return;
        setItems((old) => (append ? [...old, ...res.products] : res.products));
        setPage(res.page);
        setTotal(res.total);
      } catch (e) {
        if (request === latest.current) setError(errorText(e, tRef.current));
      } finally {
        if (request === latest.current) setBusy(false);
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
        api={api}
        signedIn={props.signedIn}
        t={t}
        locale={locale}
        onBack={() => setOpen(null)}
        onOpenSalon={props.onOpenSalon}
        onBookWith={props.onBookWith}
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

/**
 * One product: its picture and description, and the salons where the client picks it up.
 * Signed in with a visit ahead at a salon, its offer leads with "Odbiorę przy wizycie · <date>":
 * one tap puts one piece aside for that visit (paid at the salon, taken back in "Moje wizyty").
 * Without a visit there, "Zapisz się i odbierz" opens the salon's booking and the product is put
 * aside right after the visit is booked.
 */
function ProductView(props: {
  product: ShopProduct;
  api: ClientApi;
  signedIn: boolean;
  t: Dictionary;
  locale: Locale;
  onBack: () => void;
  onOpenSalon: (salon: { slug: string; name: string }) => void;
  onBookWith: (salon: { slug: string; name: string }, productId: string) => void;
}) {
  const { product: p, api, t, locale } = props;
  const [visits, setVisits] = useState<ClientAppointment[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    if (!props.signedIn) return;
    let live = true;
    api
      .appointments('upcoming')
      .then((res) => live && setVisits(res.items))
      // Without the visits the page still works: each offer shows "Umów wizytę".
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, props.signedIn]);

  const reserve = async (productId: string, visit: ClientAppointment, when: string) => {
    if (busy) return;
    setBusy(productId);
    setError('');
    try {
      await api.reserveProduct(visit.id, productId);
      setDone((d) => ({ ...d, [productId]: when }));
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(null);
    }
  };

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
      {error ? <ErrorText>{error}</ErrorText> : null}
      {p.offers.map((o) => {
        const visit = o.available ? nextVisitAt(visits, o.salon.slug) : null;
        const when = visit ? formatMoment(visit.start, visit.timezone, locale) : '';
        const reservedFor = done[o.productId];
        return (
          <Card key={o.productId}>
            <View style={styles.offerTop}>
              <Text style={[styles.name, { flex: 1 }]}>{o.salon.name}</Text>
              <Text style={styles.price}>{formatPrice(o.priceGrosze, o.currency, locale)}</Text>
            </View>
            <Text style={styles.small}>
              {[o.salon.addressLine, o.salon.city].filter(Boolean).join(', ')}
            </Text>
            {o.available ? null : <Text style={styles.small}>{t.shop.soldOut}</Text>}
            {reservedFor ? (
              <Text accessibilityRole="alert" style={styles.done}>
                {fill(t.shop.reserved, { when: reservedFor })}
              </Text>
            ) : visit ? (
              <View style={{ marginTop: 8 }}>
                <Button
                  label={fill(t.shop.reserve, { when })}
                  a11yLabel={`${fill(t.shop.reserve, { when })}: ${o.salon.name}`}
                  busy={busy === o.productId}
                  onPress={() => void reserve(o.productId, visit, when)}
                />
              </View>
            ) : o.available ? (
              <View style={{ marginTop: 8 }}>
                <Button
                  kind="secondary"
                  label={t.shop.bookAndPickUp}
                  a11yLabel={`${t.shop.bookAndPickUp}: ${o.salon.name}`}
                  onPress={() =>
                    props.onBookWith({ slug: o.salon.slug, name: o.salon.name }, o.productId)
                  }
                />
              </View>
            ) : null}
            <View style={{ marginTop: 8 }}>
              <Button
                kind={o.available ? 'link' : 'secondary'}
                label={t.shop.book}
                a11yLabel={`${t.shop.book}: ${o.salon.name}`}
                onPress={() => props.onOpenSalon({ slug: o.salon.slug, name: o.salon.name })}
              />
            </View>
          </Card>
        );
      })}
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
  done: { color: colors.ink, fontSize: 15, lineHeight: 21, fontWeight: '600', marginTop: 8 },
});
