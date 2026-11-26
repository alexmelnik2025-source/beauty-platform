import { useFormDraft } from '../formDrafts';
import { FormField } from '../formFields';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type BusinessApi, type Locale, type TillClose } from '../api';
import { dayTitle, formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  cashInput,
  changedSinceClose,
  expectedParts,
  movementReady,
  otherPaymentsLine,
  parseCash,
  tillDifference,
} from '../tillClose';
import { Button, colors, Disclosure, ErrorText, Pressable } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/** Keep the last successful report while refreshing the same salon and date. */
function TillReport(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  date: string;
  reloads: number;
  showError?: boolean;
  children: (view: TillClose, onChange: (view: TillClose) => void) => ReactNode;
}) {
  const { api, t, salon, date, reloads } = props;
  const [view, setView] = useState<TillClose | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const request = ++latest.current;
    setError('');
    api.tillClose(salon.orgId, salon.locationId, date).then(
      (next) => {
        if (request === latest.current) setView(next);
      },
      (e: unknown) => {
        if (request !== latest.current) return;
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          setView(null);
        } else {
          setError(errorText(e, t));
        }
      },
    );
    return () => {
      latest.current++;
    };
  }, [api, salon.orgId, salon.locationId, date, reloads, attempt, t]);

  function acceptChange(next: TillClose) {
    // A read started before a cash count or movement must not undo the saved report.
    latest.current++;
    setError('');
    setView(next);
  }

  return (
    <>
      {error && props.showError ? (
        <View style={styles.box}>
          <ErrorText>{error}</ErrorText>
          <Button
            kind="link"
            label={t.day.refresh}
            a11yLabel={`${t.day.refresh}: ${t.day.tillClose}`}
            onPress={() => setAttempt((n) => n + 1)}
          />
        </View>
      ) : null}
      {view?.date === date ? props.children(view, acceptChange) : null}
    </>
  );
}

function reportKey(salon: SalonChoice, date: string) {
  return `${salon.orgId}/${salon.locationId}/${date}`;
}

/**
 * Task 232: "Zamknij kasę" under "Kasa dnia" — the owner or a manager types the cash counted in
 * the till; the app puts it beside what the day's cash visits brought and says what is missing
 * or extra. Counting again replaces it. The server lets only owners and managers in, so the day
 * screen shows it only for the whole salon's till.
 * Task 236: "Wpłata / wypłata" under "Więcej" — cash put in or taken out with the reason; the till
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
  return (
    <TillReport {...props} key={reportKey(props.salon, props.date)} showError>
      {(view, onChange) => (
        <View style={styles.box}>
          <TillCount {...props} view={view} onChange={onChange} />
          <Disclosure label={props.t.navigation.more}>
            <TillMovements {...props} view={view} onChange={onChange} />
          </Disclosure>
          <OtherPayments {...props} view={view} onChange={onChange} />
        </View>
      )}
    </TillReport>
  );
}

/**
 * Task 239: "Kasa nie została zamknięta" — on today's screen the owner or a manager sees when the
 * till of the latest earlier day with cash was not counted; a tap opens that day to close it.
 * The server answers only owners and managers; for anyone else nothing is shown.
 */
export function TillReminder(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  today: string;
  reloads: number;
  onOpen: (date: string) => void;
}) {
  const { salon, today, t } = props;
  return (
    <TillReport {...props} key={reportKey(salon, today)} date={today}>
      {({ unclosedDay }) =>
        unclosedDay ? (
          <View style={styles.reminder} testID="till-reminder">
            <Text role="status" style={styles.diff}>
              {fill(t.day.tillUnclosed, { day: dayTitle(unclosedDay, props.locale) })}
            </Text>
            <Button
              kind="link"
              label={t.day.tillUnclosedOpen}
              onPress={() => props.onOpen(unclosedDay)}
            />
          </View>
        ) : null
      }
    </TillReport>
  );
}

type PartProps = Parameters<typeof TillCloseSection>[0] & {
  view: TillClose;
  onChange: (view: TillClose) => void;
};

/**
 * "Powinno być w kasie: …" with cash put in or taken out (task 236) or vouchers sold for cash, else
 * the cash visits; tasks 546–547: vouchers sold for cash and visits paid with vouchers.
 */
function ExpectedText({ view, t, locale }: PartProps) {
  const money = (hundredths: number) => formatPrice(hundredths, view.currency, locale);
  const parts = expectedParts(view);
  return (
    <>
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
      {view.vouchersCashGrosze > 0 ? (
        <Text style={styles.muted}>
          {fill(t.day.tillVouchersSold, { sum: money(view.vouchersCashGrosze) })}
        </Text>
      ) : null}
      {view.visitsProductsGrosze > 0 ? (
        <Text style={styles.muted}>
          {fill(t.day.tillVisitsProducts, { sum: money(view.visitsProductsGrosze) })}
        </Text>
      ) : null}
      {view.visitsVoucherGrosze > 0 ? (
        <Text style={styles.muted}>
          {fill(t.day.tillVisitsVouchers, { sum: money(view.visitsVoucherGrosze) })}
        </Text>
      ) : null}
    </>
  );
}

/**
 * Task 552: what the day brought not in cash — card, BLIK, transfer, other — to check with the
 * card terminal and the bank account at the end of the day.
 */
function OtherPayments({ view, t, locale }: PartProps) {
  const line = otherPaymentsLine(view, t, (hundredths) =>
    formatPrice(hundredths, view.currency, locale),
  );
  if (!line) return null;
  return (
    <Text style={styles.muted} testID="till-other">
      {line}
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
  const [open, setOpen] = useFormDraft(`tillMovement.${date}.open`, false);
  const [kind, setKind] = useFormDraft<'in' | 'out'>(`tillMovement.${date}.kind`, 'out');
  const [amount, setAmount] = useFormDraft(`tillMovement.${date}.amount`, '');
  const [note, setNote] = useFormDraft(`tillMovement.${date}.note`, '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempted, setAttempted] = useState(false);

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
    setAttempted(false);
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
                accessibilityLabel={k === 'in' ? d.tillMoveIn : d.tillMoveOut}
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
          <FormField
            error={
              (attempted || amount.trim()) && (parsed === null || parsed === 0)
                ? d.tillInvalid
                : undefined
            }
            accessibilityLabel={fill(d.tillMoveAmount, { currency: view.currency })}
            placeholder="0"
            keyboardType="decimal-pad"
            value={amount}
            onChangeText={setAmount}
            style={styles.input}
          />
          <Text style={styles.label}>{d.tillMoveNote}</Text>
          <FormField
            error={attempted && !note.trim() ? d.tillMoveReasonRequired : undefined}
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
              onPress={() => {
                setAttempted(true);
                if (!ready) return;
                void run(
                  () =>
                    api.addTillMovement(salon.orgId, salon.locationId, {
                      date,
                      kind,
                      amountGrosze: parsed ?? 0,
                      note: note.trim(),
                    }),
                  () => setOpen(false),
                );
              }}
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
  const [open, setOpen] = useFormDraft(`tillClose.${date}.open`, false);
  const [amount, setAmount] = useFormDraft(`tillClose.${date}.amount`, '');
  const [note, setNote] = useFormDraft(`tillClose.${date}.note`, '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempted, setAttempted] = useState(false);

  const money = (hundredths: number) => formatPrice(hundredths, view.currency, props.locale);
  const parsed = parseCash(amount);
  const close = view.close;
  // Task 554: "Sprawdzono z terminalem i kontem" only when the day brought something not in cash.
  const nonCash = view.otherPayments.length > 0;
  const [checked, setChecked] = useFormDraft(`tillClose.${date}.checked`, false);

  const start = () => {
    setAmount(close ? cashInput(close.countedCashGrosze) : '');
    setNote(close?.note ?? '');
    setChecked(close?.nonCashChecked ?? false);
    setError('');
    setAttempted(false);
    setOpen(true);
  };

  const save = async () => {
    setAttempted(true);
    if (parsed === null) return;
    setBusy(true);
    setError('');
    try {
      onChange(
        await api.closeTill(
          salon.orgId,
          salon.locationId,
          date,
          parsed,
          note.trim() || null,
          nonCash ? checked : undefined,
        ),
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
        <FormField
          error={(attempted || amount.trim()) && parsed === null ? d.tillInvalid : undefined}
          accessibilityLabel={fill(d.tillCounted, { currency: view.currency })}
          placeholder="0"
          keyboardType="decimal-pad"
          value={amount}
          onChangeText={setAmount}
          style={styles.input}
        />
        <Text style={styles.label}>{d.tillNote}</Text>
        <TextInput
          accessibilityLabel={d.tillNote}
          maxLength={500}
          value={note}
          onChangeText={setNote}
          style={styles.input}
        />
        {nonCash ? (
          <Pressable
            role="checkbox"
            aria-checked={checked}
            accessibilityLabel={d.tillNonCashChecked}
            accessibilityState={{ checked }}
            onPress={() => setChecked(!checked)}
            style={styles.check}
            testID="till-noncash-check"
          >
            <Text style={[styles.checkBox, checked && styles.checkBoxOn]}>
              {checked ? '✓' : ''}
            </Text>
            <Text style={styles.checkLabel}>{d.tillNonCashChecked}</Text>
          </Pressable>
        ) : null}
        {error ? <ErrorText>{error}</ErrorText> : null}
        <View style={styles.row}>
          <Button label={d.tillSave} busy={busy} onPress={() => void save()} />
          <Button kind="link" label={d.tillCancel} onPress={() => setOpen(false)} />
        </View>
      </View>
    );
  }

  if (!close) {
    return (
      <View style={styles.row}>
        <Button label={d.tillClose} onPress={start} />
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
      {close.nonCashChecked ? (
        <Text style={styles.muted} testID="till-noncash-checked">
          ✓ {d.tillNonCashCheckedDone}
        </Text>
      ) : null}
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
        <Button label={d.tillRecount} onPress={start} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 6, paddingTop: 8 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  checkBox: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 4,
    textAlign: 'center',
    lineHeight: 20,
    color: '#fff',
  },
  checkBoxOn: { backgroundColor: colors.ink },
  checkLabel: { color: colors.ink, fontSize: 15, flexShrink: 1 },
  reminder: {
    gap: 4,
    marginTop: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.ink,
    borderRadius: 8,
  },
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
