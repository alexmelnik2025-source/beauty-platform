import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Locale, TillClose } from '../api';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { cashInput, changedSinceClose, parseCash, tillDifference } from '../tillClose';
import { Button, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 232: "Zamknij kasę" under "Kasa dnia" — the owner or a manager types the cash counted in
 * the till; the app puts it beside what the day's cash visits brought and says what is missing
 * or extra. Counting again replaces it. The server lets only owners and managers in, so the day
 * screen shows it only for the whole salon's till.
 */
export function TillCloseSection(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  date: string;
  timeZone: string;
  /** Changes whenever the day is reloaded, so a later cash payment shows at once. */
  reloads: number;
}) {
  const { api, t, salon, date } = props;
  const d = t.day;
  const [view, setView] = useState<TillClose | null>(null);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .tillClose(salon.orgId, salon.locationId, date)
      .then((v) => {
        if (alive) setView(v);
      })
      .catch(() => {
        if (alive) setView(null);
      });
    return () => {
      alive = false;
    };
  }, [api, salon, date, props.reloads]);

  useEffect(() => setOpen(false), [date]);

  if (!view || view.date !== date) return null;
  const money = (hundredths: number) => formatPrice(hundredths, view.currency, props.locale);
  const parsed = parseCash(amount);
  const close = view.close;

  const start = () => {
    setAmount(close ? cashInput(close.countedCashGrosze) : '');
    setNote(close?.note ?? '');
    setError('');
    setOpen(true);
  };

  const save = async () => {
    if (parsed === null) return;
    setBusy(true);
    setError('');
    try {
      setView(
        await api.closeTill(salon.orgId, salon.locationId, date, parsed, note.trim() || null),
      );
      setOpen(false);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    return (
      <View style={styles.box} testID="till-close-form">
        <Text style={styles.muted}>
          {fill(d.tillExpected, { sum: money(view.expectedCashGrosze) })}
        </Text>
        <Text style={styles.label}>{fill(d.tillCounted, { currency: view.currency })}</Text>
        <TextInput
          accessibilityLabel={fill(d.tillCounted, { currency: view.currency })}
          placeholder="0"
          keyboardType="decimal-pad"
          value={amount}
          onChangeText={setAmount}
          style={styles.input}
        />
        {amount.trim() !== '' && parsed === null ? (
          <Text style={styles.muted}>{d.tillInvalid}</Text>
        ) : null}
        <Text style={styles.label}>{d.tillNote}</Text>
        <TextInput
          accessibilityLabel={d.tillNote}
          maxLength={500}
          value={note}
          onChangeText={setNote}
          style={styles.input}
        />
        {error ? <ErrorText>{error}</ErrorText> : null}
        <View style={styles.row}>
          <Button
            label={d.tillSave}
            busy={busy}
            disabled={parsed === null}
            onPress={() => void save()}
          />
          <Button kind="link" label={d.tillCancel} onPress={() => setOpen(false)} />
        </View>
      </View>
    );
  }

  if (!close) {
    return (
      <View style={styles.row}>
        <Button kind="secondary" label={d.tillClose} onPress={start} />
      </View>
    );
  }

  const diff = tillDifference(close);
  return (
    <View style={styles.box} testID="till-closed">
      <Text style={styles.title}>
        {d.tillClosed}:{' '}
        {fill(d.tillCountedOf, {
          counted: money(close.countedCashGrosze),
          expected: money(close.expectedCashGrosze),
        })}
      </Text>
      <Text style={[styles.diff, diff.kind === 'missing' && styles.missing]} testID="till-diff">
        {diff.kind === 'matches'
          ? d.tillMatches
          : fill(diff.kind === 'missing' ? d.tillMissing : d.tillSurplus, {
              sum: money(diff.grosze),
            })}
      </Text>
      {close.note ? <Text style={styles.muted}>{close.note}</Text> : null}
      <Text style={styles.muted}>
        {fill(d.tillClosedBy, {
          name: close.closedByName,
          time: new Date(close.closedAt).toLocaleTimeString(props.locale, {
            timeZone: props.timeZone,
            hour: '2-digit',
            minute: '2-digit',
          }),
        })}
      </Text>
      {changedSinceClose(view) ? (
        <Text style={styles.muted}>
          {fill(d.tillChanged, { sum: money(view.expectedCashGrosze) })}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Button kind="link" label={d.tillRecount} onPress={start} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 6, paddingTop: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  title: { fontSize: 15, fontWeight: '600', color: colors.ink },
  diff: { fontSize: 15, color: colors.ink },
  missing: { fontWeight: '700', textDecorationLine: 'underline' },
  label: { fontSize: 14, color: colors.ink },
  muted: { fontSize: 14, color: colors.muted },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    backgroundColor: colors.card,
    color: colors.ink,
    minWidth: 140,
  },
});
