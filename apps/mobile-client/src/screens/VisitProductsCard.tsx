import { memo, useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { ClientApi, Locale, VisitProducts } from '../api';
import { API_URL } from '../config';
import { errorText } from '../errors';
import { formatPrice } from '../format';
import { fill, type Dictionary } from '../i18n';
import { visitProductLists, invalidateProductLists, type recentReads } from '../shop';
import { Button, colors, ErrorText } from '../ui';
import { withNetworkTimeout } from '../withNetworkTimeout';

// Keep the last successful list on screen if a refresh fails.
export function useVisitProductList<T>(
  api: ClientApi,
  visitId: string,
  t: Dictionary,
  cache: ReturnType<typeof recentReads<T>>,
  read: (this: ClientApi, id: string) => Promise<T>,
) {
  const [data, setData] = useState<T | null>(null);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setFailure(null);
    cache
      .read(api, visitId, () => withNetworkTimeout(read.call(api, visitId)))
      .then(
        (items) => {
          if (live) setData(items);
        },
        (e) => {
          if (live) setFailure({ cause: e });
        },
      );
    return () => {
      live = false;
    };
  }, [api, visitId, cache, read, attempt]);
  const feedback = failure ? (
    <View>
      <ErrorText>{errorText(failure.cause, t)}</ErrorText>
      <Button kind="secondary" label={t.retry} onPress={() => setAttempt((n) => n + 1)} />
    </View>
  ) : null;
  const refresh = async () => setData(await withNetworkTimeout(read.call(api, visitId)));
  return { data, setData, feedback, refresh };
}

// Visit mutations return the whole list. Serialize them so an older response cannot undo
// another row's update, including taps delivered before React renders the disabled state.
export function useProductLock() {
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  return {
    busy,
    acquire() {
      if (active.current) return false;
      active.current = true;
      setBusy(true);
      return true;
    },
    release() {
      active.current = false;
      setBusy(false);
    },
  };
}

type ProductAction = (retry: boolean) => Promise<void>;

export function ProductActionButton(props: {
  lock: ReturnType<typeof useProductLock>;
  api: ClientApi;
  t: Dictionary;
  label: string;
  a11yLabel: string;
  kind?: 'link' | 'secondary';
  disabled?: boolean;
  action: ProductAction;
  refresh?: () => Promise<void>;
}) {
  const { lock, t } = props;
  const [failure, setFailure] = useState<{ message: string; action: ProductAction } | null>(null);
  async function press() {
    if (!lock.acquire()) return;
    // Keep the original reservation snapshot even if a different row has since changed.
    const action = failure?.action ?? props.action;
    try {
      await action(Boolean(failure));
      setFailure(null);
    } catch (e) {
      setFailure({ message: errorText(e, t), action });
      await props.refresh?.().catch(() => undefined);
    } finally {
      invalidateProductLists(props.api);
      lock.release();
    }
  }
  return (
    <>
      {failure ? <ErrorText>{failure.message}</ErrorText> : null}
      <Button
        kind={props.kind}
        label={failure ? t.retry : props.label}
        a11yLabel={failure ? `${t.retry}: ${props.a11yLabel}` : props.a11yLabel}
        disabled={lock.busy || props.disabled}
        onPress={() => void press()}
      />
    </>
  );
}

// A POST creates a new reservation even when a previous response was lost. Compare IDs
// before replaying it, since the client may already have reserved this product earlier.
export function reserveOne(
  api: ClientApi,
  visitId: string,
  productId: string,
  before?: VisitProducts,
) {
  return async (retry: boolean) => {
    if (!before) before = await api.visitProducts(visitId);
    else if (retry) {
      const previousIds = new Set(before.reservations.map((r) => r.id));
      const current = await api.visitProducts(visitId);
      if (
        current.reservations.some(
          (r) => r.productId === productId && r.status === 'reserved' && !previousIds.has(r.id),
        )
      )
        return current;
    }
    return api.reserveProduct(visitId, productId);
  };
}

/**
 * Task Q3 (screen B in the app): "Produkty do odbioru" in the visit card of "Moje wizyty" — what
 * I put aside for this visit, and "+ Dodaj produkt do tej wizyty" (folded) with the salon's
 * products; "Odbiorę przy wizycie" puts one aside, paid at the salon. Nothing is shown when the
 * salon has no products for clients and nothing was put aside — the visit card stays as it was.
 */
type Props = {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  visitId: string;
};
export const VisitProductsCard = memo(function VisitProductsCard(props: Props) {
  return <VisitProductsContent key={props.visitId} {...props} />;
});

function VisitProductsContent(props: Props) {
  const { api, t, locale, visitId } = props;
  const s = t.visitProducts;
  const [open, setOpen] = useState(false);
  const lock = useProductLock();
  const { data, setData, feedback, refresh } = useVisitProductList(
    api,
    visitId,
    t,
    visitProductLists,
    api.visitProducts,
  );
  if (!data)
    return (
      feedback && (
        <View role="region" aria-label={s.title} style={styles.card}>
          <Text role="heading" aria-level={2} style={styles.title}>
            {s.title}
          </Text>
          {feedback}
        </View>
      )
    );
  const reserved = data.reservations.filter((r) => r.status !== 'cancelled');
  if (reserved.length === 0 && (!data.canChange || data.available.length === 0)) return null;
  const money = (n: number) => formatPrice(n, data.currency, locale);

  return (
    <View role="region" aria-label={s.title} style={styles.card} testID="visit-products">
      <Text role="heading" aria-level={2} style={styles.title}>
        {s.title}
      </Text>
      {feedback}
      {reserved.map((r) => (
        <View key={r.id} style={styles.row}>
          <ProductDetails
            name={r.name}
            photoId={r.photoId}
            quantity={r.quantity}
            amount={r.totalGrosze}
            currency={data.currency}
            locale={locale}
            status={
              r.status === 'reserved'
                ? s.statusReserved
                : r.status === 'handed'
                  ? s.statusHanded
                  : s.statusExpired
            }
          />
          {data.canChange && r.status === 'reserved' ? (
            <ProductActionButton
              api={api}
              t={t}
              lock={lock}
              refresh={refresh}
              kind="link"
              label={s.giveBack}
              a11yLabel={`${s.giveBack}: ${r.name}`}
              action={async (retry) => {
                if (retry) {
                  const current = await api.visitProducts(visitId);
                  if (
                    !current.reservations.some(
                      (item) => item.id === r.id && item.status === 'reserved',
                    )
                  ) {
                    setData(current);
                    return;
                  }
                }
                setData(await api.unreserveProduct(visitId, r.id));
              }}
            />
          ) : null}
        </View>
      ))}
      {reserved.length > 0 ? (
        <Text style={styles.muted}>{fill(s.total, { amount: money(data.totalGrosze) })}</Text>
      ) : null}
      {data.canChange && data.available.length > 0 ? (
        <>
          <Button kind="secondary" label={s.add} expanded={open} onPress={() => setOpen(!open)} />
          {open
            ? data.available.map((p) => (
                <View key={p.id} style={styles.row}>
                  <ProductDetails
                    name={p.name}
                    photoId={p.photoId}
                    brand={p.brand}
                    amount={p.priceGrosze}
                    currency={data.currency}
                    locale={locale}
                    available={p.available}
                    status={s.unavailable}
                  />
                  <ProductActionButton
                    api={api}
                    t={t}
                    lock={lock}
                    refresh={refresh}
                    kind="secondary"
                    label={s.reserve}
                    a11yLabel={`${s.reserve}: ${p.name}`}
                    disabled={!p.available}
                    action={async (retry) =>
                      setData(await reserveOne(api, visitId, p.id, data)(retry))
                    }
                  />
                </View>
              ))
            : null}
          <Text style={styles.muted}>{s.pickup}</Text>
        </>
      ) : null}
    </View>
  );
}

const ProductDetails = memo(function ProductDetails({
  name,
  photoId,
  quantity,
  brand,
  amount,
  currency,
  locale,
  available,
  status,
}: {
  name: string;
  photoId: string | null;
  quantity?: number;
  brand?: string | null;
  amount: number;
  currency: string;
  locale: Locale;
  available?: boolean;
  status: string;
}) {
  const price = formatPrice(amount, currency, locale);
  return (
    <>
      {photoId ? (
        <Image
          accessible
          accessibilityLabel={name}
          resizeMethod="resize"
          source={{ uri: `${API_URL}/v1/public/photos/${photoId}` }}
          style={styles.photo}
        />
      ) : null}
      <View style={styles.grow}>
        <Text style={styles.name}>
          {quantity && quantity > 1 ? `${name} × ${quantity}` : name}
          {brand ? <Text style={styles.muted}> · {brand}</Text> : null}
        </Text>
        {available === undefined ? (
          <>
            <Text style={styles.price}>{price}</Text>
            <Text style={styles.muted}>{status}</Text>
          </>
        ) : (
          <Text style={styles.muted}>
            {price}
            {!available ? ` · ${status}` : ''}
          </Text>
        )}
      </View>
    </>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 16,
    gap: 12,
  },
  title: { fontSize: 18, fontWeight: '700', color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  grow: { flexGrow: 1, flexShrink: 1, gap: 2, flexBasis: 140, minWidth: 0 },
  photo: { width: 48, height: 48, borderRadius: 8 },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  price: { fontSize: 15, color: colors.ink },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
});
