import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  bookAgainUrl,
  newRequestKey,
  type ClientApi,
  type ClientAppointment,
  type Locale,
} from '../api';
import { WEB_URL } from '../config';
import { errorText } from '../errors';
import { formatDay, formatMoment, formatPrice, salonAddress, visitActions } from '../format';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading } from '../ui';

/**
 * One visit: when, what, with whom, where and for how much; cancel (asks first, until the
 * salon's deadline), call the salon, book the same service again.
 */
export function VisitScreen(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  /** The visit as the list showed it; refreshed from the server on opening. */
  visit: ClientAppointment;
  onBack: () => void;
  /** The visit changed (cancelled): the list reloads when the client goes back. */
  onChanged: () => void;
  onSessionEnded: () => void;
}) {
  const { api, t, locale, onBack, onSessionEnded } = props;
  const [visit, setVisit] = useState<ClientAppointment>(props.visit);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const tRef = useRef(t);
  tRef.current = t;
  // One key per "Yes": a second tap or a retry after a lost answer cancels once.
  const keyRef = useRef(newRequestKey());

  const refresh = useCallback(async () => {
    try {
      setVisit(await api.appointment(props.visit.id));
    } catch (e) {
      if (!api.signedIn) return onSessionEnded();
      setError(errorText(e, tRef.current));
    }
  }, [api, props.visit.id, onSessionEnded]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Android "back" closes the card instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  async function cancel() {
    setBusy(true);
    setError('');
    try {
      setVisit(await api.cancel(visit.id, keyRef.current));
      setAsking(false);
      setDone(t.visit.cancelled);
      props.onChanged();
    } catch (e) {
      if (!api.signedIn) return onSessionEnded();
      setAsking(false);
      setError(errorText(e, t));
      keyRef.current = newRequestKey();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const v = t.visit;
  const day = formatDay(visit.date, locale);
  const actions = visitActions(visit);
  const again = bookAgainUrl(WEB_URL, locale, visit);
  const address = salonAddress(visit.salon);
  const faded = visit.status === 'cancelled' || visit.status === 'expired';

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.top}>
        <Button kind="link" label={v.back} onPress={onBack} />
      </View>
      <Heading>{visit.service.name}</Heading>
      <View style={styles.when}>
        <Text style={[styles.day, faded && styles.faded]}>
          {day}, {fill(v.at, { time: visit.time })}
        </Text>
        <Text
          style={[
            styles.badge,
            visit.status === 'confirmed' && styles.badgeOk,
            (visit.status === 'cancelled' || visit.status === 'no_show') && styles.badgeOff,
          ]}
        >
          {t.visits.status[visit.status]}
        </Text>
      </View>

      {done ? (
        <Text role="status" style={styles.done}>
          {done}
        </Text>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}

      <Card>
        <Row label={v.staff} value={visit.staff.displayName} />
        <Row label={v.duration} value={`${visit.service.durationMinutes} ${t.visits.minutes}`} />
        <Row label={v.price} value={formatPrice(visit.service.priceGrosze, locale)} />
      </Card>

      <Card>
        <Text style={styles.label}>{v.salon}</Text>
        <Text style={styles.salon}>{visit.salon.name}</Text>
        {address ? <Text style={styles.muted}>{address}</Text> : null}
      </Card>

      {actions.cancel ? (
        <Text style={styles.muted}>
          {fill(v.changeUntil, {
            when: formatMoment(visit.changeableUntil, visit.timezone, locale),
          })}
        </Text>
      ) : null}
      {actions.tooLate ? <Text style={styles.muted}>{v.tooLateHint}</Text> : null}

      {actions.cancel && !asking ? (
        <Button kind="secondary" label={v.cancel} onPress={() => setAsking(true)} />
      ) : null}
      {actions.cancel && asking ? (
        <View role="alertdialog" aria-label={v.cancel} style={styles.ask}>
          <Text style={styles.askText}>{fill(v.cancelAsk, { day, time: visit.time })}</Text>
          <View style={styles.askButtons}>
            <View style={{ flex: 1 }}>
              <Button
                kind="secondary"
                label={v.cancelNo}
                disabled={busy}
                onPress={() => setAsking(false)}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button label={v.cancelYes} busy={busy} onPress={() => void cancel()} />
            </View>
          </View>
        </View>
      ) : null}

      {visit.salon.phone ? (
        <Button
          kind="secondary"
          label={`${v.callSalon} ${visit.salon.phone}`}
          onPress={() => void Linking.openURL(`tel:${visit.salon.phone}`)}
        />
      ) : null}
      {again ? (
        <>
          <Button label={v.bookAgain} onPress={() => void Linking.openURL(again)} />
          <Text style={styles.small}>{v.bookAgainHint}</Text>
        </>
      ) : null}
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 14 },
  top: { flexDirection: 'row', marginLeft: -8 },
  when: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  day: { fontSize: 18, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  faded: { color: colors.muted, textDecorationLine: 'line-through' },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  small: { color: colors.muted, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  label: { color: colors.muted, fontSize: 13 },
  salon: { fontSize: 16, fontWeight: '600', color: colors.ink },
  value: { fontSize: 15, fontWeight: '600', color: colors.ink },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, gap: 12 },
  done: { color: '#1e6b3a', fontSize: 15, fontWeight: '600' },
  ask: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: 16,
    gap: 12,
  },
  askText: { fontSize: 16, color: colors.ink, fontWeight: '600' },
  askButtons: { flexDirection: 'row', gap: 10 },
  badge: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  badgeOk: { color: '#1e6b3a', borderColor: '#b9dcc4', backgroundColor: '#eef7f0' },
  badgeOff: { color: colors.danger, borderColor: '#efc6c2' },
});
