import { memo, useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Product, Stocktake } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { stocktakeCount } from '../stock';
import { Button, Card, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

const StocktakeRow = memo(function StocktakeRow({
  product,
  draft,
  busy,
  count,
  p,
  onChange,
}: {
  product: Product;
  draft: string | undefined;
  busy: boolean;
  count: number | null | undefined;
  p: Dictionary['products'];
  onChange: (id: string, value: string) => void;
}) {
  const { id, name, stockQuantity } = product;
  const diff = typeof count === 'number' && stockQuantity !== null ? count - stockQuantity : 0;
  const invalid = count === undefined;
  const rangeError = invalid ? `! ${fill(p.orderPieces, { n: '0–100 000' })}` : undefined;
  const errorId = `stocktake-error-${id}`;
  return (
    <View style={styles.product} testID="stocktake-row">
      <View style={styles.row}>
        <View style={styles.details}>
          <Text style={styles.name}>{name}</Text>
          <Text style={styles.muted}>
            {stockQuantity === null
              ? p.stocktakeWasNone
              : fill(p.stocktakeWas, { n: String(stockQuantity) })}
            {diff !== 0
              ? ` · ${fill(diff < 0 ? p.stocktakeMissing : p.stocktakeExtra, { n: String(Math.abs(diff)) })}`
              : ''}
          </Text>
        </View>
        <View style={styles.field}>
          <TextInput
            accessibilityLabel={fill(p.stocktakeCount, { name })}
            accessibilityHint={rangeError}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            placeholder="—"
            placeholderTextColor={colors.placeholder}
            keyboardType="number-pad"
            editable={!busy}
            value={draft ?? String(stockQuantity ?? '')}
            onChangeText={(value) => onChange(id, value)}
            style={[styles.input, invalid && styles.invalidInput]}
          />
          {rangeError ? (
            <Text
              role="alert"
              accessibilityLiveRegion="polite"
              nativeID={errorId}
              style={styles.warn}
            >
              {rangeError}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
});

export function StocktakeCard(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  products: Product[];
  onSaved: (result: Stocktake) => void;
}) {
  const { api, t, salon, products } = props;
  const p = t.products;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const changeCount = useCallback((id: string, value: string) => {
    setDrafts((previous) => ({ ...previous, [id]: value }));
  }, []);

  const changes: { productId: string; quantity: number }[] = [];
  let invalid = false;
  const rows = products.map((product) => {
    const draft = drafts[product.id];
    const count = stocktakeCount(draft, product.stockQuantity);
    if (count === undefined) invalid = true;
    else if (typeof count === 'number' && count !== product.stockQuantity) {
      changes.push({ productId: product.id, quantity: count });
    }
    return (
      <StocktakeRow
        key={product.id}
        product={product}
        draft={draft}
        busy={busy}
        count={count}
        p={p}
        onChange={changeCount}
      />
    );
  });
  const disabled = invalid || changes.length === 0;

  const save = async () => {
    if (saving.current || disabled) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      props.onSaved(await api.stocktake(salon.orgId, salon.locationId, changes));
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <View testID="stocktake" role="group" accessibilityLabel={p.stocktakeTitle} accessible={false}>
      <Card>
        <Text role="heading" aria-level={3} style={styles.title}>
          {p.stocktakeTitle}
        </Text>
        {rows}
        {error ? <ErrorText>{error}</ErrorText> : null}
        <View style={{ marginTop: 8 }}>
          <Button
            label={p.stocktakeSave}
            busy={busy}
            disabled={disabled}
            onPress={() => void save()}
          />
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '700', color: colors.ink },
  product: { marginTop: 8 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  details: { flex: 1, minWidth: 0 },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  muted: { color: colors.muted, fontSize: 14 },
  warn: { color: colors.danger, fontSize: 14, marginTop: 4, textAlign: 'right' },
  invalidInput: { borderColor: colors.danger },
  field: { width: 112, maxWidth: '100%' },
  input: {
    minHeight: 44,
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
