import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type {
  ClientApi,
  ClientAppointment,
  ClientAppointmentList,
  Locale,
  ShopCategory,
  ShopOffer,
  ShopProduct,
} from '../api';
import { API_URL } from '../config';
import { errorText } from '../errors';
import { formatMoment, formatPrice } from '../format';
import { fill, type Dictionary } from '../i18n';
import { tokenStore } from '../storage';
import {
  catalogPages,
  recentReads,
  searchShop,
  fromCurrency,
  nextVisitAt,
  SHOP_CATEGORIES,
  sellersLine,
} from '../shop';
import { ProductActionButton, reserveOne, useProductLock } from './VisitProductsCard';
import { Button, Card, Chip, colors, ErrorText, Heading, Pressable } from '../ui';

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
  const search = query.trim();
  const [category, setCategory] = useState<ShopCategory | null>(null);
  const [items, setItems] = useState<ShopProduct[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState<{ page: number; message: string } | null>(null);
  const [open, setOpen] = useState<ShopProduct | null>(null);
  const active = useRef<AbortController | null>(null);
  const submit = useRef<(() => void) | null>(null);
  const lastSearch = useRef('');
  const visits = useMemo(() => recentReads<ClientAppointmentList>(), [api, props.signedIn]);
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(
    async (nextPage: number) => {
      if (active.current) return;
      const controller = new AbortController();
      active.current = controller;
      setBusy(true);
      setFailure(null);
      const key = JSON.stringify([search, category, nextPage]);
      try {
        const res = await catalogPages.read(api, key, () => {
          controller.signal.addEventListener('abort', () => catalogPages.clear(api, key), {
            once: true,
          });
          return searchShop(
            API_URL,
            tokenStore,
            { q: search, category: category ?? undefined, page: nextPage },
            controller.signal,
          );
        });
        if (controller.signal.aborted) return;
        // Reopening an empty shop should discover the first product as soon as it is listed.
        if (!search && !category && res.total === 0) catalogPages.clear(api, key);
        setItems((old) => (nextPage > 1 ? [...old, ...res.products] : res.products));
        setPage(res.page);
        setTotal(res.total);
      } catch (e) {
        if (!controller.signal.aborted)
          setFailure({ page: nextPage, message: errorText(e, tRef.current) });
      } finally {
        if (active.current === controller) {
          active.current = null;
          setBusy(false);
        }
      }
    },
    [api, search, category],
  );

  useEffect(() => {
    const start = () => {
      submit.current = null;
      lastSearch.current = search;
      void load(1);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (search && lastSearch.current !== search) {
      setBusy(true);
      timer = setTimeout(start, TYPING_MS);
      submit.current = () => {
        clearTimeout(timer);
        start();
      };
    } else {
      start();
    }
    return () => {
      clearTimeout(timer);
      submit.current = null;
      active.current?.abort();
      active.current = null;
    };
  }, [load, search]);

  if (open) {
    return (
      <ProductView
        product={open}
        visitReads={visits}
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

  const filtered = Boolean(search || category);
  const empty = !busy && !failure && items.length === 0;
  function clearFilters() {
    setQuery('');
    setCategory(null);
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      {(!empty || filtered) && (
        <View style={styles.top}>
          <Button kind="link" label={t.salon.back} onPress={props.onBack} />
        </View>
      )}
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
        onSubmitEditing={() => submit.current?.()}
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
      {failure && !busy ? (
        <View>
          <ErrorText>{failure.message}</ErrorText>
          <Button kind="secondary" label={t.retry} onPress={() => void load(failure.page)} />
        </View>
      ) : null}
      {empty ? (
        <View style={styles.empty}>
          <Text role="status" style={styles.text}>
            {filtered ? t.shop.noMatch : t.shop.empty}
          </Text>
          <Button
            kind="secondary"
            label={filtered ? t.catalog.clearLanguages : t.salon.back}
            onPress={filtered ? clearFilters : props.onBack}
          />
        </View>
      ) : null}
      {items.map((p) => (
        <ProductRow key={p.id} product={p} locale={locale} t={t} onOpen={setOpen} />
      ))}
      {busy && items.length === 0 ? (
        <View
          accessible
          role="progressbar"
          accessibilityLabel={t.shop.title}
          aria-busy
          style={styles.row}
        >
          <View style={[styles.thumb, styles.noPhoto]} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={styles.skeletonLine} />
            <View style={[styles.skeletonLine, { width: '65%' }]} />
          </View>
        </View>
      ) : busy ? (
        <ActivityIndicator accessibilityLabel={t.shop.title} color={colors.ink} />
      ) : null}
      {!busy && !failure && items.length < total ? (
        <Button kind="secondary" label={t.shop.more} onPress={() => void load(page + 1)} />
      ) : null}
    </ScrollView>
  );
}

const ProductRow = memo(function ProductRow({
  product: p,
  locale,
  t,
  onOpen,
}: {
  product: ShopProduct;
  locale: Locale;
  t: Dictionary;
  onOpen: (product: ShopProduct) => void;
}) {
  const sellers = sellersLine(p);
  const price = formatPrice(p.fromPriceGrosze, fromCurrency(p), locale);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${p.name}, ${fill(t.shop.from, { price })}`}
      onPress={() => onOpen(p)}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      {p.photoId ? (
        <Image
          resizeMethod="resize"
          source={{ uri: photoUri(p.photoId) }}
          accessibilityLabel={p.name}
          style={styles.thumb}
        />
      ) : (
        <View style={[styles.thumb, styles.noPhoto]} />
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.name}>{p.name}</Text>
        {p.brand ? <Text style={styles.small}>{p.brand}</Text> : null}
        <Text style={styles.price}>{fill(t.shop.from, { price })}</Text>
        <Text style={styles.small}>
          {sellers === null
            ? t.shop.soldOut
            : sellers.kind === 'one'
              ? sellers.salon
              : fill(t.shop.salons, { n: String(sellers.n) })}
        </Text>
      </View>
    </Pressable>
  );
});

/**
 * One product: its picture and description, and the salons where the client picks it up.
 * Signed in with a visit ahead at a salon, its offer leads with "Odbiorę przy wizycie · <date>":
 * one tap puts one piece aside for that visit (paid at the salon, taken back in "Moje wizyty").
 * Without a visit there, "Zapisz się i odbierz" opens the salon's booking and the product is put
 * aside right after the visit is booked.
 */
function ProductView(props: {
  visitReads: ReturnType<typeof recentReads<ClientAppointmentList>>;
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
  const [visits, setVisits] = useState<ClientAppointment[] | null>(null);
  const [visitsError, setVisitsError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!props.signedIn) return;
    let live = true;
    setVisits(null);
    setVisitsError('');
    props.visitReads
      .read(api, 'upcoming', () => api.appointments('upcoming'))
      .then((res) => live && setVisits(res.items))
      .catch((e) => live && setVisitsError(errorText(e, t)));
    return () => {
      live = false;
    };
  }, [api, props.signedIn, props.visitReads, attempt, t]);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.top}>
        <Button kind="link" label={t.shop.backToShop} onPress={props.onBack} />
      </View>
      {p.photoId ? (
        <Image
          source={{ uri: photoUri(p.photoId) }}
          style={styles.photo}
          accessible
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
      {props.signedIn && visits === null && !visitsError ? (
        <ActivityIndicator accessibilityLabel={t.visits.upcoming} color={colors.ink} />
      ) : null}
      {visitsError ? (
        <View>
          <ErrorText>{visitsError}</ErrorText>
          <Button kind="secondary" label={t.retry} onPress={() => setAttempt((n) => n + 1)} />
        </View>
      ) : null}
      {p.offers.map((o) => (
        <OfferRow
          key={o.productId}
          offer={o}
          productName={p.name}
          visitsKnown={!props.signedIn || visits !== null}
          visit={props.signedIn && o.available && visits ? nextVisitAt(visits, o.salon.slug) : null}
          api={api}
          locale={locale}
          t={t}
          onOpenSalon={props.onOpenSalon}
          onBookWith={props.onBookWith}
        />
      ))}
    </ScrollView>
  );
}

const OfferRow = memo(function OfferRow({
  offer: o,
  productName,
  visitsKnown,
  visit,
  api,
  locale,
  t,
  onOpenSalon,
  onBookWith,
}: {
  offer: ShopOffer;
  productName: string;
  visitsKnown: boolean;
  visit: ClientAppointment | null;
  api: ClientApi;
  locale: Locale;
  t: Dictionary;
  onOpenSalon: (salon: { slug: string; name: string }) => void;
  onBookWith: (salon: { slug: string; name: string }, productId: string) => void;
}) {
  const [reservedFor, setReservedFor] = useState('');
  const lock = useProductLock();
  const reserve = visit ? reserveOne(api, visit.id, o.productId) : null;
  const when = visit ? formatMoment(visit.start, visit.timezone, locale) : '';
  return (
    <Card>
      <View style={styles.offerTop}>
        <Text style={[styles.name, styles.offerSalon]}>{o.salon.name}</Text>
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
      ) : reserve ? (
        <View style={{ marginTop: 8 }}>
          <ProductActionButton
            api={api}
            t={t}
            lock={lock}
            label={fill(t.shop.reserve, { when })}
            a11yLabel={`${fill(t.shop.reserve, { when })}, ${productName}: ${o.salon.name}`}
            action={async (retry) => {
              await reserve(retry);
              setReservedFor(when);
            }}
          />
        </View>
      ) : o.available && visitsKnown ? (
        <View style={{ marginTop: 8 }}>
          <Button
            kind="secondary"
            label={t.shop.bookAndPickUp}
            a11yLabel={`${t.shop.bookAndPickUp}: ${o.salon.name}`}
            onPress={() => onBookWith({ slug: o.salon.slug, name: o.salon.name }, o.productId)}
          />
        </View>
      ) : null}
      <View style={{ marginTop: 8 }}>
        <Button
          kind={o.available ? 'link' : 'secondary'}
          label={t.shop.book}
          a11yLabel={`${t.shop.book}: ${o.salon.name}`}
          onPress={() => onOpenSalon({ slug: o.salon.slug, name: o.salon.name })}
        />
      </View>
    </Card>
  );
});

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
  empty: { gap: 8 },
  skeletonLine: { height: 12, borderRadius: 6, backgroundColor: colors.soft },
  offerSalon: { flexBasis: 140, flexGrow: 1, minWidth: 0 },
  offerTop: { flexWrap: 'wrap', flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  done: { color: colors.ink, fontSize: 15, lineHeight: 21, fontWeight: '600', marginTop: 8 },
});
