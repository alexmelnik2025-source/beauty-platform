import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, Locale, VisitReservations } from '../api';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { Button, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const money = (n: number) => formatPrice(n, salon.currency, props.locale);

  const load = useCallback(
    () =>
      api
        .visitReservations(salon.orgId, salon.locationId, appointmentId)
        .then(setData)
        .catch(() => setData(null)),
    [api, salon, appointmentId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (reservationId: string, action: 'hand-over' | 'cancel') => {
    if (busy) return;
    setBusy(true);
    setError('');
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
      setError(errorText(e, t));
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!data) return null;
  const waiting = data.reservations.filter((r) => r.status === 'reserved');
  const handed = data.reservations.filter((r) => r.status === 'handed');
  if (waiting.length === 0 && handed.length === 0) return null;

  return (
    <View style={styles.card} testID="visit-to-hand">
      <Text style={styles.title} accessibilityRole="header">
        🛍️ {p.toHandTitle}
      </Text>
      {[...waiting, ...handed].map((r) => (
        <View key={r.id} style={{ gap: 4 }}>
          <View style={styles.row}>
            <Text style={styles.name}>{r.quantity > 1 ? `${r.name} × ${r.quantity}` : r.name}</Text>
            <Text style={styles.muted}>{money(r.totalGrosze)}</Text>
          </View>
          {r.status === 'handed' ? (
            <Text style={styles.muted}>{p.toHandHanded}</Text>
          ) : canChange ? (
            <View style={styles.row}>
              {completed ? (
                <Button
                  label={p.toHandGive}
                  a11yLabel={fill(p.toHandGiveFor, { name: r.name })}
                  disabled={busy}
                  onPress={() => void run(r.id, 'hand-over')}
                />
              ) : null}
              <Button
                kind="link"
                label={p.toHandCancel}
                a11yLabel={fill(p.toHandCancelFor, { name: r.name })}
                disabled={busy}
                onPress={() => void run(r.id, 'cancel')}
              />
            </View>
          ) : null}
        </View>
      ))}
      {data.toHandGrosze > 0 ? (
        <Text style={styles.muted}>
          {fill(p.toHandTotal, { amount: money(data.toHandGrosze) })}
        </Text>
      ) : null}
      {waiting.length > 0 && canChange && !completed ? (
        <Text style={styles.muted}>{p.toHandAfterCame}</Text>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
  name: { fontSize: 16, color: colors.ink, flexShrink: 1, flexGrow: 1 },
  muted: { color: colors.muted, fontSize: 14 },
});
