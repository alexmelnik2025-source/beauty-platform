import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Locale, TillClose } from '../api';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  cashInput,
  changedSinceClose,
  expectedParts,
  movementReady,
  parseCash,
  tillDifference,
} from '../tillClose';
import { Button, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 232: "Zamknij kasę" under "Kasa dnia" — the owner or a manager types the cash counted in
 * the till; the app puts it beside what the day's cash visits brought and says what is missing
 * or extra. Counting again replaces it. The server lets only owners and managers in, so the day
 * screen shows it only for the whole salon's till.
 * Task 236: "Wpłata / wypłata" above it — cash put in or taken out with the reason; the till
 * should then hold the cash visits plus what was put in minus what was taken out.
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
  const { api, salon, date } = props;
  const [view, setView] = useState<TillClose | null>(null);

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

  if (!view || view.date !== date) return null;
  return (
    <View style={styles.box}>
      <TillMovements {...props} view={view} onChange={setView} />
      <TillCount {...props} view={view} onChange={setView} />
    </View>
  );
}

type PartProps = Parameters<typeof TillCloseSection>[0] & {
  view: TillClose;
  onChange: (view: TillClose) => void;
};

/** "Powinno być w kasie: …" with cash put in or taken out (task 236), else the cash visits. */
function ExpectedText({ view, t, locale }: PartProps) {
  const money = (hundredths: number) => formatPrice(hundredths, view.currency, locale);
  const parts = expectedParts(view);
  return (
    <Text style={styles.muted}>
      {parts.kind === 'visits'
        ? fill(t.day.tillExpected, { sum: money(parts.visits) })
        : fill(t.day.tillShouldBe, {
            sum: money(parts.total),
            visits: money(parts.visits),
            in: money(parts.cashIn),
            out: money(parts.cashOut),
          })}
    </Text>
  );
}

/**
 * Task 236: "Wpłata / wypłata" — cash put into or taken out of the till with the reason, the
 * day's list and "Usuń" for a mistake.
 */
function TillMovements(props: PartProps) {
  const { api, t, salon, view, onChange } = props;
  const d = t.day;
  const date = view.date;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'in' | 'out'>('out');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setOpen(false), [date]);

  const money = (hundredths: number) => formatPrice(hundredths, view.currency, props.locale);
  const parsed = parseCash(amount);
  const ready = movementReady(parsed, note);

  const run = async (call: () => Promise<TillClose>, after?: () => void) => {
    setBusy(true);
    setError('');
    try {
      onChange(await call());
      after?.();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    setKind('out');
    setAmount('');
    setNote('');
    setError('');
    setOpen(true);
  };

  const rowText = (m: TillClose['movements'][number]) =>
    `${fill(m.kind === 'in' ? d.tillMoveInRow : d.tillMoveOutRow, { sum: money(m.amountGrosze) })} · ${m.note}`;

  return (
    <View style={styles.box}>
      {view.movements.length > 0 ? (
        <View testID="till-moves" accessibilityLabel={d.tillMoves}>
          {view.movements.map((m) => (
            <View key={m.id} style={styles.row}>
              <Text style={styles.label}>{rowText(m)}</Text>
              <Text style={styles.muted}>
                {fill(d.tillClosedBy, {
                  name: m.createdByName,
                  time: new Date(m.createdAt).toLocaleTimeString(props.locale, {
                    timeZone: props.timeZone,
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                })}
              </Text>
              <Button
                kind="link"
                label={d.tillMoveRemove}
                a11yLabel={fill(d.tillMoveRemoveLabel, { what: rowText(m) })}
                disabled={busy}
                onPress={() =>
                  void run(() => api.removeTillMovement(salon.orgId, salon.locationId, m.id))
                }
              />
            </View>
          ))}
        </View>
      ) : null}
      {open ? (
        <View style={styles.box} testID="till-move-form">
          <View style={styles.row} accessibilityRole="radiogroup">
            {(['out', 'in'] as const).map((k) => (
              <Pressable
                key={k}
                accessibilityRole="radio"
                accessibilityState={{ checked: kind === k }}
                onPress={() => setKind(k)}
                style={[styles.chip, kind === k && styles.chipOn]}
              >
                <Text style={[styles.chipText, kind === k && styles.chipTextOn]}>
                  {k === 'in' ? d.tillMoveIn : d.tillMoveOut}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.label}>{fill(d.tillMoveAmount, { currency: view.currency })}</Text>
          <TextInput
            accessibilityLabel={fill(d.tillMoveAmount, { currency: view.currency })}
            placeholder="0"
            keyboardType="decimal-pad"
            value={amount}
            onChangeText={setAmount}
            style={styles.input}
          />
          {amount.trim() !== '' && (parsed === null || parsed === 0) ? (
            <Text style={styles.muted}>{d.tillInvalid}</Text>
          ) : null}
          <Text style={styles.label}>{d.tillMoveNote}</Text>
          <TextInput
            accessibilityLabel={d.tillMoveNote}
            placeholder={d.tillMoveHint}
            maxLength={200}
            value={note}
            onChangeText={setNote}
            style={styles.input}
          />
          {error ? <ErrorText>{error}</ErrorText> : null}
          <View style={styles.row}>
            <Button
              label={d.tillSave}
              busy={busy}
              disabled={!ready}
              onPress={() =>
                void run(
                  () =>
                    api.addTillMovement(salon.orgId, salon.locationId, {
                      date,
                      kind,
                      amountGrosze: parsed ?? 0,
                      note: note.trim(),
                    }),
                  () => setOpen(false),
                )
              }
            />
            <Button kind="link" label={d.tillCancel} onPress={() => setOpen(false)} />
          </View>
        </View>
      ) : (
        <>
          {error ? <ErrorText>{error}</ErrorText> : null}
          <View style={styles.row}>
            <Button kind="secondary" label={d.tillMove} onPress={start} />
          </View>
        </>
      )}
    </View>
  );
}

/** Task 232: "Zamknij kasę" / the closed till / "Policz ponownie". */
function TillCount(props: PartProps) {
  const { api, t, salon, view, onChange } = props;
  const d = t.day;
  const date = view.date;
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setOpen(false), [date]);

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
      onChange(
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
        <ExpectedText {...props} />
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
  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { color: colors.ink, fontSize: 14 },
  chipTextOn: { color: '#fff', fontWeight: '600' },
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
