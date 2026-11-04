import { useCallback, useEffect, useState } from 'react';
import { BackHandler, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, type AppointmentDetail, type BusinessApi, type Locale } from '../api';
import { dayTitle, formatPrice, timeIn, visitActions } from '../day';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * One visit: time, client (contacts only with the permission — the server leaves them out),
 * service, specialist, price, note; "came / did not come" and "paid" as in the web calendar.
 */
export function VisitScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  id: string;
  timeZone: string;
  canChange: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { api, t, salon, id, onBack } = props;
  const [visit, setVisit] = useState<AppointmentDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setVisit(await api.appointment(salon.orgId, salon.locationId, id));
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Android "back" closes the card instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  async function run(action: (v: AppointmentDetail) => Promise<AppointmentDetail>) {
    if (!visit) return;
    setBusy(true);
    setError('');
    try {
      setVisit(await action(visit));
      props.onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setError(t.visit.conflict);
        await load();
      } else {
        setError(errorText(e, t));
      }
    } finally {
      setBusy(false);
    }
  }

  const v = t.visit;
  const back = <Button kind="link" label={v.back} onPress={onBack} />;
  if (!visit) {
    return (
      <View style={styles.screen}>
        <View style={styles.row}>{back}</View>
        {error ? <ErrorText>{error}</ErrorText> : <Text style={styles.muted}>{t.loading}</Text>}
      </View>
    );
  }

  const actions = visitActions(visit, props.canChange);
  const phone = visit.customer?.phone ?? null;
  const setStatus = (status: 'completed' | 'no_show') =>
    run((a) => api.setStatus(salon.orgId, salon.locationId, a.id, a.version, status));
  const setPaid = (paid: boolean) =>
    run((a) => api.setPaid(salon.orgId, salon.locationId, a.id, a.version, paid));

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.row}>{back}</View>
      <Heading>
        {visit.time}–{timeIn(visit.end, props.timeZone)}
      </Heading>
      <Text style={styles.muted}>{dayTitle(visit.date, props.locale)}</Text>

      <View style={styles.chips}>
        <Text style={[styles.chip, visit.status === 'no_show' && styles.chipBad]}>
          {v.status[visit.status]}
        </Text>
        {visit.paidAt ? <Text style={styles.chip}>✓ {v.paid}</Text> : null}
        <Text style={styles.chip}>{visit.source === 'online' ? v.online : v.manual}</Text>
        {visit.firstVisit ? <Text style={styles.chip}>{v.firstVisit}</Text> : null}
      </View>

      {error ? <ErrorText>{error}</ErrorText> : null}

      <Card>
        <Text style={styles.label}>{v.client}</Text>
        <Text style={styles.value}>{visit.customer?.name ?? t.day.walkIn}</Text>
        {phone ? (
          <View style={styles.row}>
            <Button
              kind="secondary"
              label={`${v.call} ${phone}`}
              onPress={() => void Linking.openURL(`tel:${phone}`)}
            />
            <Button
              kind="secondary"
              label={v.sms}
              onPress={() => void Linking.openURL(`sms:${phone}`)}
            />
          </View>
        ) : visit.customer && !visit.customer.email ? (
          <Text style={styles.muted}>{v.contactsHidden}</Text>
        ) : null}
        {visit.customer?.email ? <Text style={styles.muted}>{visit.customer.email}</Text> : null}

        <Text style={styles.label}>{v.service}</Text>
        <Text style={styles.value}>
          {visit.service.name}
          <Text style={styles.muted}>
            {' '}
            · {visit.durationMinutes} {v.minutes}
          </Text>
        </Text>

        <Text style={styles.label}>{v.staff}</Text>
        <Text style={styles.value}>{visit.staff.displayName}</Text>

        {visit.priceGrosze !== null ? (
          <>
            <Text style={styles.label}>{v.price}</Text>
            <Text style={styles.value}>
              {formatPrice(visit.priceGrosze, salon.currency, props.locale)}
            </Text>
          </>
        ) : null}

        {visit.note ? (
          <>
            <Text style={styles.label}>{v.note}</Text>
            <Text style={styles.value}>{visit.note}</Text>
          </>
        ) : null}
      </Card>

      {actions.came ? (
        <View style={styles.row}>
          <Button label={v.markCame} busy={busy} onPress={() => void setStatus('completed')} />
          <Button
            kind="secondary"
            label={v.markNoShow}
            disabled={busy}
            onPress={() => void setStatus('no_show')}
          />
        </View>
      ) : props.canChange && visit.status === 'confirmed' ? (
        <Text style={styles.muted}>{v.notStarted}</Text>
      ) : null}
      {actions.pay ? (
        <>
          <Text style={styles.muted}>{v.paidHint}</Text>
          <Button label={v.markPaid} busy={busy} onPress={() => void setPaid(true)} />
        </>
      ) : null}
      {actions.unpay ? (
        <Button
          kind="secondary"
          label={v.unmarkPaid}
          busy={busy}
          onPress={() => void setPaid(false)}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  chips: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  chip: {
    fontSize: 12,
    color: colors.ink,
    backgroundColor: '#efe7d8',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
  chipBad: { backgroundColor: '#f6dcd9', color: colors.danger },
  label: { marginTop: 8, fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  value: { fontSize: 17, color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
});
