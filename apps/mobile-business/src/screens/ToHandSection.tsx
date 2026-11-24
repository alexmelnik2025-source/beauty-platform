import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, Locale, VisitReservations } from '../api';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { Button, colors } from '../ui';
import type { SalonChoice } from './SalonsScreen';

type Action = 'hand-over' | 'cancel';

function validAmount(grosze: number) {
  return Number.isSafeInteger(grosze) && grosze >= 0;
}

function InlineError({ label, message }: { label: string; message: string }) {
  return (
    <Text
      role="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${label}. ${message}`}
      style={styles.error}
    >
      ! {message}
    </Text>
  );
}

/**
 * Task Q3 (screen D): "Do wydania klientowi" in the visit card — as in the cabinet. The products
 * the client put aside for this visit; "Wydaj i dolicz" makes one the usual sale at the visit
 * (the visit must be marked "Przyszedł"), "Anuluj" frees the pieces. Nothing when nothing waits.
 * `onHanded` lets the card reload "Produkty".
 */
export function ToHandSection(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  appointmentId: string;
  canChange: boolean;
  completed: boolean;
  onHanded: () => void;
}) {
  const { api, t, salon, appointmentId, canChange, completed, onHanded } = props;
  const p = t.products;
  const [data, setData] = useState<VisitReservations | null>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ id: string; action: Action; message: string } | null>(null);
  const money = (n: number) => formatPrice(n, salon.currency, props.locale);

  const load = useCallback(
    () => api.visitReservations(salon.orgId, salon.locationId, appointmentId),
    [api, salon.orgId, salon.locationId, appointmentId],
  );

  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    void load().then(
      (result) => {
        if (active) setData(result);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [load]);

  const run = async (reservationId: string, action: Action) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      setData(
        await api.reservationAction(
          salon.orgId,
          salon.locationId,
          appointmentId,
          reservationId,
          action,
        ),
      );
      if (action === 'hand-over') onHanded();
    } catch (e) {
      setError({ id: reservationId, action, message: errorText(e, t) });
      // The mutation may have reached the server. Keep the row available if the refresh also fails.
      await load().then(setData, () => {});
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  if (!data) return null;
  const waiting = data.reservations.filter((r) => r.status === 'reserved');
  const handed = data.reservations.filter((r) => r.status === 'handed');
  if (waiting.length === 0 && handed.length === 0) return null;

  const priceLabel = fill(p.priceIn, { currency: salon.currency });
  const showTotal =
    validAmount(data.toHandGrosze) &&
    data.toHandGrosze > 0 &&
    waiting.every((r) => validAmount(r.totalGrosze));

  function actionButton(r: VisitReservations['reservations'][number], action: Action) {
    const give = action === 'hand-over';
    const label = fill(give ? p.toHandGiveFor : p.toHandCancelFor, { name: r.name });
    const failed = error?.id === r.id && error.action === action;
    return (
      <View style={styles.feedback}>
        <View style={failed && styles.invalid}>
          <Button
            kind={give ? 'primary' : 'link'}
            label={give ? p.toHandGive : p.toHandCancel}
            a11yLabel={label}
            disabled={busy || (give && !validAmount(r.totalGrosze))}
            onPress={() => void run(r.id, action)}
          />
        </View>
        {failed && <InlineError label={label} message={error.message} />}
      </View>
    );
  }

  return (
    <View style={styles.card} testID="visit-to-hand">
      <Text style={styles.title} accessibilityRole="header" accessibilityLabel={p.toHandTitle}>
        🛍️ {p.toHandTitle}
      </Text>
      {[...waiting, ...handed].map((r) => (
        <View key={r.id} style={styles.item} testID="to-hand-product">
          <View accessible={validAmount(r.totalGrosze)} style={styles.row}>
            <Text style={styles.name}>{r.quantity > 1 ? `${r.name} × ${r.quantity}` : r.name}</Text>
            {validAmount(r.totalGrosze) ? (
              <Text style={styles.muted}>{money(r.totalGrosze)}</Text>
            ) : (
              <View style={styles.feedback}>
                <Text style={[styles.muted, styles.invalid]}>{priceLabel}</Text>
                <InlineError label={`${r.name}, ${priceLabel}`} message={t.error.generic} />
              </View>
            )}
          </View>
          {r.status === 'handed' ? (
            <Text style={styles.muted}>{p.toHandHanded}</Text>
          ) : canChange ? (
            <View style={styles.row}>
              {completed && actionButton(r, 'hand-over')}
              {actionButton(r, 'cancel')}
            </View>
          ) : null}
        </View>
      ))}
      {showTotal ? (
        <Text style={styles.muted}>
          {fill(p.toHandTotal, { amount: money(data.toHandGrosze) })}
        </Text>
      ) : null}
      {waiting.length > 0 && canChange && !completed ? (
        <Text style={styles.muted}>{p.toHandAfterCame}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 8,
    marginTop: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  title: { fontSize: 16, fontWeight: '700', color: colors.ink },
  item: { gap: 4 },
  error: { color: colors.danger, fontSize: 15 },
  feedback: { maxWidth: '100%', gap: 4 },
  invalid: { borderWidth: 1, borderColor: colors.danger, borderRadius: 12, padding: 2 },
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
    flexBasis: 144,
    maxWidth: '100%',
    flexShrink: 1,
    flexGrow: 1,
  },
  muted: { color: colors.muted, fontSize: 14, maxWidth: '100%' },
});
