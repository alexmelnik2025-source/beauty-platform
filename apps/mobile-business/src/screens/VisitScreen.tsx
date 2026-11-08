import { useCallback, useEffect, useState } from 'react';
import {
  BackHandler,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  ApiError,
  type AppointmentDetail,
  type BusinessApi,
  type Locale,
  type VisitPhotoList,
} from '../api';
import { addDays, dayTitle, formatPrice, timeIn, todayIn, visitActions } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  cancelReason,
  createProblem,
  freeTimes,
  mayBookAgain,
  mayMoveOrCancel,
  presetFromVisit,
} from '../newVisit';
import { wishLines } from '../wishes';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import { ClientScreen } from './ClientScreen';
import { PaymentMethodPicker } from './PaymentMethodPicker';
import { VisitCouponsSection } from './VisitCouponsSection';
import { mayUseCoupons } from '../visitCoupons';
import type { PaymentMethod } from '../payment';
import { parseTip, tipInput } from '../tip';
import type { NewVisitPreset } from '../waitlist';
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
  /** Task 223: "Umów ponownie" — absent when this person may not add visits. */
  onBookAgain?: (preset: NewVisitPreset) => void;
}) {
  const { api, t, salon, id, onBack } = props;
  const [visit, setVisit] = useState<AppointmentDetail | null>(null);
  /** Task 80b: the client's example photos ("Pokaż, co chcesz"). */
  const [photos, setPhotos] = useState<VisitPhotoList | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [clientOpen, setClientOpen] = useState(false);
  /** Task 227: how the client paid, chosen before "Opłacono". */
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  /** Task 229: the tip field, as typed. */
  const [tipText, setTipText] = useState<string | null>(null);
  // Move / cancel (task 17b).
  const [mode, setMode] = useState<'move' | 'cancel' | null>(null);
  const [moveDate, setMoveDate] = useState('');
  const [times, setTimes] = useState<{ time: string; start: string }[] | null>(null);
  const [ask, setAsk] = useState<{ time: string; start: string } | null>(null);
  const [reason, setReason] = useState('');
  const [askCancel, setAskCancel] = useState(false);
  const [notice, setNotice] = useState('');
  const today = todayIn(props.timeZone);

  const load = useCallback(async () => {
    try {
      const [detail, pictures] = await Promise.all([
        api.appointment(salon.orgId, salon.locationId, id),
        api.visitPhotos(salon.orgId, salon.locationId, id).catch(() => null),
      ]);
      setVisit(detail);
      setPhotos(pictures);
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Android "back" closes the card instead of the app (the client card handles it itself).
  useEffect(() => {
    if (clientOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack, clientOpen]);

  async function run(
    action: (v: AppointmentDetail) => Promise<AppointmentDetail>,
  ): Promise<boolean> {
    if (!visit) return false;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setVisit(await action(visit));
      props.onChanged();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setError(t.visit.conflict);
        await load();
      } else {
        const kind = createProblem(e);
        setError(kind === 'other' ? errorText(e, t) : t.newVisit.problem[kind]);
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Free times of the same specialist and service on the chosen day.
  const serviceId = visit?.service.id;
  const staffId = visit?.staff.id;
  useEffect(() => {
    if (mode !== 'move' || !moveDate || !serviceId || !staffId) return;
    let alive = true;
    setTimes(null);
    api
      .availability(salon.orgId, salon.locationId, { serviceId, staffId, date: moveDate })
      .then((a) => alive && setTimes(freeTimes(a, staffId, moveDate)))
      .catch((e: unknown) => alive && setError(errorText(e, t)));
    return () => {
      alive = false;
    };
  }, [api, salon, mode, moveDate, serviceId, staffId, t]);

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

  if (clientOpen && visit.customer) {
    return (
      <ClientScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        id={visit.customer.id}
        timeZone={props.timeZone}
        onBack={() => setClientOpen(false)}
      />
    );
  }

  const actions = visitActions(visit, props.canChange);
  const phone = visit.customer?.phone ?? null;
  const setStatus = (status: 'completed' | 'no_show') =>
    run((a) => api.setStatus(salon.orgId, salon.locationId, a.id, a.version, status));
  const tipValue = parseTip(tipText ?? tipInput(visit.tipGrosze));
  const setPaid = (paid: boolean, method?: PaymentMethod | null) =>
    run((a) => api.setPaid(salon.orgId, salon.locationId, a.id, a.version, paid, method));

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
        {visit.awaitingApproval ? (
          <Text style={[styles.chip, styles.chipStrong]}>⏳ {v.awaitingApproval}</Text>
        ) : null}
        {visit.paidAt ? (
          <Text style={styles.chip}>
            ✓ {v.paid}
            {visit.paymentMethod ? ` · ${v.paymentMethods[visit.paymentMethod]}` : ''}
          </Text>
        ) : null}
        <Text style={styles.chip}>{visit.source === 'online' ? v.online : v.manual}</Text>
        {visit.firstVisit ? <Text style={styles.chip}>{v.firstVisit}</Text> : null}
        {visit.customer?.birthdayToday ? (
          <Text style={styles.chip}>🎂 {v.birthdayToday}</Text>
        ) : null}
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
        {visit.customer ? (
          <View style={styles.row}>
            <Button kind="link" label={t.clients.card} onPress={() => setClientOpen(true)} />
            {props.onBookAgain && mayBookAgain(visit, true) ? (
              <Button
                kind="link"
                label={v.bookAgain}
                onPress={() => {
                  const preset = presetFromVisit(visit, today);
                  if (preset) props.onBookAgain?.(preset);
                }}
              />
            ) : null}
          </View>
        ) : null}

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

        {/* Task 80: what the client asked for when booking (the server shows them by permission). */}
        {wishLines(visit.wishes, v).length > 0 ? (
          <>
            <Text style={styles.label}>{v.wishes}</Text>
            {wishLines(visit.wishes, v).map((line) => (
              <Text key={line} style={styles.value}>
                {line}
              </Text>
            ))}
          </>
        ) : null}

        {photos && photos.items.length > 0 ? (
          <>
            <Text style={styles.label}>📷 {v.photos}</Text>
            <View style={styles.photos}>
              {photos.items.map((p, i) => (
                <Pressable
                  key={p.id}
                  accessibilityRole="link"
                  accessibilityLabel={fill(v.photoAlt, { n: String(i + 1) })}
                  onPress={() => void Linking.openURL(api.absoluteUrl(p.url))}
                >
                  <Image
                    source={{ uri: api.absoluteUrl(p.url) }}
                    accessibilityIgnoresInvertColors
                    style={styles.photo}
                  />
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
      </Card>

      {props.canChange && visit.awaitingApproval ? (
        <>
          <Text style={styles.muted}>{v.approveHint}</Text>
          <Button
            label={v.approve}
            busy={busy}
            onPress={() =>
              void run((a) => api.approve(salon.orgId, salon.locationId, a.id, a.version))
            }
          />
        </>
      ) : null}
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
      {mayUseCoupons(visit, props.canChange) ? (
        <VisitCouponsSection
          api={api}
          t={t}
          locale={props.locale}
          salon={salon}
          visit={visit}
          onVisit={(next) => {
            setVisit(next);
            props.onChanged();
          }}
        />
      ) : null}
      {actions.pay ? (
        <>
          <Text style={styles.muted}>{v.paidHint}</Text>
          <PaymentMethodPicker t={t} value={method} onChange={setMethod} disabled={busy} />
          <Button
            label={v.markPaid}
            busy={busy}
            onPress={() => void setPaid(true, method ?? undefined)}
          />
        </>
      ) : null}
      {actions.unpay ? (
        // Task 227: on a paid visit a tap changes only how it was paid.
        <PaymentMethodPicker
          t={t}
          value={visit.paymentMethod}
          onChange={(next) => void setPaid(true, next)}
          disabled={busy}
        />
      ) : null}
      {actions.unpay ? (
        <Button
          kind="secondary"
          label={v.unmarkPaid}
          busy={busy}
          onPress={() => void setPaid(false)}
        />
      ) : null}
      {props.canChange && visit.status === 'completed' ? (
        // Task 229: the tip — only a note for the report and "Kasa dnia".
        <View style={{ gap: 6 }} testID="tip-field">
          <Text style={styles.label}>{fill(v.tip, { currency: salon.currency })}</Text>
          <View style={styles.row}>
            <TextInput
              accessibilityLabel={fill(v.tip, { currency: salon.currency })}
              placeholder="0"
              keyboardType="decimal-pad"
              value={tipText ?? tipInput(visit.tipGrosze)}
              onChangeText={setTipText}
              style={[styles.input, { minWidth: 120 }]}
            />
            <Button
              kind="secondary"
              label={v.tipSave}
              busy={busy}
              disabled={tipValue === null || tipValue === visit.tipGrosze}
              onPress={() => {
                if (tipValue === null) return;
                void run((a) =>
                  api.setTip(salon.orgId, salon.locationId, a.id, a.version, tipValue),
                ).then((ok) => {
                  if (ok) setTipText(null);
                });
              }}
            />
          </View>
          <Text style={styles.muted}>{tipValue === null ? v.tipInvalid : v.tipHint}</Text>
        </View>
      ) : visit.tipGrosze > 0 ? (
        <Text style={styles.value}>
          {fill(v.tipShown, {
            amount: formatPrice(visit.tipGrosze, salon.currency, props.locale),
          })}
        </Text>
      ) : null}

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {visit.status === 'cancelled' && visit.cancelReason ? (
        <Card>
          <Text style={styles.label}>{v.cancelReasonLabel}</Text>
          <Text style={styles.value}>{visit.cancelReason}</Text>
        </Card>
      ) : null}

      {mayMoveOrCancel(visit, props.canChange) && !mode ? (
        <View style={styles.row}>
          <Button
            kind="secondary"
            label={v.move}
            onPress={() => {
              setMode('move');
              setAsk(null);
              setMoveDate(visit.date < today ? today : visit.date);
            }}
          />
          <Button
            kind="secondary"
            label={v.cancel}
            onPress={() => {
              setMode('cancel');
              setAskCancel(false);
            }}
          />
        </View>
      ) : null}

      {mode === 'move' ? (
        <Card>
          <Text style={styles.label}>{v.moveTitle}</Text>
          <View style={styles.row}>
            <Button
              kind="secondary"
              label="‹"
              a11yLabel={v.previousDay}
              disabled={moveDate <= today}
              onPress={() => {
                setMoveDate(addDays(moveDate, -1));
                setAsk(null);
              }}
            />
            <Text style={styles.dayName}>{dayTitle(moveDate, props.locale)}</Text>
            <Button
              kind="secondary"
              label="›"
              a11yLabel={v.nextDay}
              onPress={() => {
                setMoveDate(addDays(moveDate, 1));
                setAsk(null);
              }}
            />
          </View>
          {ask ? (
            <>
              <Text style={styles.value}>
                {fill(v.moveAsk, { when: `${dayTitle(moveDate, props.locale)} ${ask.time}` })}
              </Text>
              <View style={styles.row}>
                <Button
                  label={v.yes}
                  busy={busy}
                  onPress={() =>
                    void run((a) =>
                      api.reschedule(salon.orgId, salon.locationId, a.id, a.version, ask.start),
                    ).then((ok) => {
                      if (!ok) return;
                      setMode(null);
                      setNotice(v.moved);
                    })
                  }
                />
                <Button kind="secondary" label={v.no} onPress={() => setAsk(null)} />
              </View>
            </>
          ) : !times ? (
            <Text style={styles.muted}>{t.loading}</Text>
          ) : times.length === 0 ? (
            <Text style={styles.muted}>{v.noTimes}</Text>
          ) : (
            <View style={styles.times}>
              {times.map((s) => (
                <Pressable
                  key={s.start}
                  accessibilityRole="button"
                  onPress={() => setAsk(s)}
                  style={styles.time}
                >
                  <Text style={styles.timeText}>{s.time}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <Button kind="link" label={v.close} onPress={() => setMode(null)} />
        </Card>
      ) : null}

      {mode === 'cancel' ? (
        <Card>
          <TextInput
            accessibilityLabel={v.reason}
            placeholder={v.reason}
            value={reason}
            maxLength={300}
            onChangeText={(text) => {
              setReason(text);
              setAskCancel(false);
            }}
            style={styles.input}
          />
          {askCancel ? (
            <>
              <Text style={styles.value}>{v.cancelAsk}</Text>
              <View style={styles.row}>
                <Button
                  label={v.cancelYes}
                  busy={busy}
                  onPress={() =>
                    void run((a) =>
                      api.cancel(
                        salon.orgId,
                        salon.locationId,
                        a.id,
                        a.version,
                        cancelReason(reason) ?? '',
                      ),
                    ).then((ok) => {
                      if (!ok) return;
                      setMode(null);
                      setNotice(v.cancelled);
                    })
                  }
                />
                <Button kind="secondary" label={v.no} onPress={() => setAskCancel(false)} />
              </View>
            </>
          ) : (
            <View style={styles.row}>
              <Button
                label={v.cancel}
                onPress={() => {
                  if (cancelReason(reason)) setAskCancel(true);
                  else setError(v.badReason);
                }}
              />
              <Button kind="link" label={v.close} onPress={() => setMode(null)} />
            </View>
          )}
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  photo: { width: 88, height: 88, borderRadius: 10, backgroundColor: colors.line },
  screen: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  chips: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  chip: {
    fontSize: 12,
    color: colors.ink,
    backgroundColor: colors.soft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
  chipBad: { backgroundColor: '#f6dcd9', color: colors.danger },
  chipStrong: { backgroundColor: colors.ink, color: '#ffffff' },
  label: { marginTop: 8, fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  value: { fontSize: 17, color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
  notice: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  dayName: { fontSize: 16, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  times: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  time: {
    minWidth: 72,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  timeText: { fontSize: 16, fontWeight: '600', color: colors.ink },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    backgroundColor: colors.card,
    color: colors.ink,
  },
});
