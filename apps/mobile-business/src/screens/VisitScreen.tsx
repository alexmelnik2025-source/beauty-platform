import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ProductSalesSection } from './ProductSalesSection';
import { ToHandSection } from './ToHandSection';
import { VisitVoucherSection } from './VisitVoucherSection';
import {
  BackHandler,
  Image,
  Linking,
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
import { useClearFormDraft, useFormDraft } from '../formDrafts';
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
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
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
type VisitProps = {
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
};

export function VisitScreen(props: VisitProps) {
  const { orgId, locationId, role } = props.salon;
  const draftKey = `visit.${JSON.stringify([orgId, locationId, role, props.id])}`;
  return <VisitCard key={draftKey} {...props} draftKey={draftKey} />;
}

type VisitAction = 'approve' | 'status' | 'payment' | 'tip' | 'move' | 'cancel';
type MoveDraft = { date: string; start: string | null };
type PendingAction = VisitAction | 'refresh' | null;

function isDraftSave(action: PendingAction) {
  return action === 'move' || action === 'cancel';
}

function VisitCard(props: VisitProps & { draftKey: string }) {
  const { api, t, salon, id, onBack, draftKey } = props;
  const [visit, setVisit] = useState<AppointmentDetail | null>(null);
  /** Task 80b: the client's example photos ("Pokaż, co chcesz"). */
  const [photos, setPhotos] = useState<VisitPhotoList | null>(null);
  const [photoFailure, setPhotoFailure] = useState<{ cause: unknown } | null>(null);
  const [photoAttempt, setPhotoAttempt] = useState(0);
  const [actionError, setActionError] = useState<{ action: VisitAction; message: string } | null>(
    null,
  );
  const locked = useRef<PendingAction>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const busy = pendingAction !== null;
  const savingDraft = isDraftSave(pendingAction);
  // Task Q3 (screen D): a product handed over is a new sale — "Produkty" reloads.
  const [salesKey, setSalesKey] = useState(0);
  const [clientOpen, setClientOpen] = useState(false);
  /** Task 227: how the client paid, chosen before "Opłacono". */
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  /** Task 229: the tip field, as typed. */
  const [tipText, setTipText] = useState<string | null>(null);
  // Move / cancel (task 17b).
  const [mode, setMode] = useState<'move' | 'cancel' | null>(null);
  const [moveDraft, setMoveDraft] = useFormDraft<MoveDraft | null>(`${draftKey}.move`, null);
  const clearMove = useClearFormDraft(`${draftKey}.move`);
  const today = mode === 'move' ? todayIn(props.timeZone) : '';
  const chosenDate = moveDraft?.date ?? visit?.date ?? '';
  const moveDate = chosenDate < today ? today : chosenDate;
  const [times, setTimes] = useState<{ time: string; start: string }[] | null>(null);
  const [timesError, setTimesError] = useState('');
  const [timesAttempt, setTimesAttempt] = useState(0);
  const ask = times?.find((slot) => slot.start === moveDraft?.start);
  const [reason, setReason] = useFormDraft(`${draftKey}.cancelReason`, '');
  const clearReason = useClearFormDraft(`${draftKey}.cancelReason`);
  const [reasonSubmitted, setReasonSubmitted] = useState(false);
  const badReason = reasonSubmitted && !cancelReason(reason);
  const [askCancel, setAskCancel] = useState(false);
  const [notice, setNotice] = useState('');
  const { orgId, locationId } = salon;
  const scope = useRef<AbortController | null>(null);
  const [loadFailure, setLoadFailure] = useState<{ cause: unknown; afterConflict: boolean } | null>(
    null,
  );
  const loadDetail = useCallback(
    async (signal: AbortSignal, afterConflict = false) => {
      try {
        const detail = await api.appointment(orgId, locationId, id);
        if (!signal.aborted) {
          setVisit(detail);
          setLoadFailure(null);
          if (afterConflict) setNotice(t.visit.conflict);
        }
      } catch (cause) {
        if (!signal.aborted) setLoadFailure({ cause, afterConflict });
      }
    },
    [api, orgId, locationId, id, t.visit.conflict],
  );

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    scope.current = controller;
    // Start both reads together. Only the detail is needed to show the card.
    void loadDetail(signal);
    return () => controller.abort();
  }, [loadDetail]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    api.visitPhotos(orgId, locationId, id).then(
      (pictures) => {
        if (!signal.aborted) setPhotos(pictures);
      },
      (cause) => {
        if (!signal.aborted) setPhotoFailure({ cause });
      },
    );
    return () => controller.abort();
  }, [api, orgId, locationId, id, photoAttempt]);

  // Android "back" closes the card instead of the app (the client card handles it itself).
  useEffect(() => {
    if (clientOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!isDraftSave(locked.current)) onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack, clientOpen]);

  async function run(
    name: VisitAction,
    action: (v: AppointmentDetail) => Promise<AppointmentDetail>,
    onSaved?: () => void,
  ): Promise<boolean> {
    const signal = scope.current?.signal;
    if (!visit || locked.current || !signal || signal.aborted) return false;
    locked.current = name;
    setPendingAction(name);
    setLoadFailure(null);
    setActionError(null);
    setNotice('');
    try {
      const updated = await action(visit);
      onSaved?.();
      if (signal.aborted) return false;
      setVisit(updated);
      props.onChanged();
      return true;
    } catch (e) {
      if (signal.aborted) return false;
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        await loadDetail(signal, true);
      } else {
        const kind = createProblem(e);
        setActionError({
          action: name,
          message: kind === 'other' ? errorText(e, t) : t.newVisit.problem[kind],
        });
      }
      return false;
    } finally {
      locked.current = null;
      if (!signal.aborted) setPendingAction(null);
    }
  }

  // Free times of the same specialist and service on the chosen day.
  const serviceId = visit?.service.id;
  const staffId = visit?.staff.id;
  useEffect(() => {
    if (mode !== 'move' || !moveDate || !serviceId || !staffId) return;
    let alive = true;
    setTimes(null);
    setTimesError('');
    api
      .availability(orgId, locationId, { serviceId, staffId, date: moveDate })
      .then((a) => alive && setTimes(freeTimes(a, staffId, moveDate)))
      .catch((e: unknown) => alive && setTimesError(errorText(e, t)));
    return () => {
      alive = false;
    };
  }, [api, orgId, locationId, mode, moveDate, serviceId, staffId, t, timesAttempt]);

  function chooseMoveDate(date: string) {
    setTimes(null);
    setMoveDraft({ date, start: null });
  }

  const v = t.visit;
  const inlineError = (name: VisitAction) =>
    actionError?.action === name ? <ErrorText>{actionError.message}</ErrorText> : null;
  const detailError = loadFailure && (
    <>
      <ErrorText>{errorText(loadFailure.cause, t)}</ErrorText>
      <Button
        label={t.day.refresh}
        kind="secondary"
        busy={busy}
        onPress={async () => {
          const signal = scope.current?.signal;
          if (!signal || signal.aborted || locked.current) return;
          locked.current = 'refresh';
          setPendingAction('refresh');
          try {
            await loadDetail(signal, loadFailure.afterConflict);
          } finally {
            locked.current = null;
            if (!signal.aborted) setPendingAction(null);
          }
        }}
      />
    </>
  );
  const back = <Button kind="link" label={v.back} disabled={savingDraft} onPress={onBack} />;
  if (!visit) {
    return (
      <View style={styles.screen}>
        <View style={styles.row}>{back}</View>
        {detailError ?? <Text style={styles.muted}>{t.loading}</Text>}
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

  const wishes = wishLines(visit.wishes, v);
  const actions = visitActions(visit, props.canChange);
  const badPrice =
    visit.priceGrosze !== null &&
    (!Number.isSafeInteger(visit.priceGrosze) ||
      visit.priceGrosze < 0 ||
      visit.priceGrosze > 10_000_000);
  const phone = visit.customer?.phone ?? null;
  const setStatus = (status: 'completed' | 'no_show') =>
    run('status', (a) => api.setStatus(salon.orgId, salon.locationId, a.id, a.version, status));
  const tipValue = parseTip(tipText ?? tipInput(visit.tipGrosze));
  const tipMessage =
    tipValue === null
      ? v.tipInvalid
      : actionError?.action === 'tip'
        ? actionError.message
        : undefined;
  const reasonMessage = badReason
    ? v.badReason
    : actionError?.action === 'cancel'
      ? actionError.message
      : undefined;
  const setPaid = (paid: boolean, method?: PaymentMethod | null) =>
    run('payment', (a) =>
      api.setPaid(salon.orgId, salon.locationId, a.id, a.version, paid, method),
    );

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>{back}</View>
      <VisitHeader visit={visit} v={v} timeZone={props.timeZone} locale={props.locale} />

      {detailError}

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
                disabled={savingDraft}
                onPress={() => {
                  const preset = presetFromVisit(visit, todayIn(props.timeZone));
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
            {badPrice ? (
              <View style={styles.invalidPrice}>
                <ErrorText>! {t.loyalty.problem.cost}</ErrorText>
              </View>
            ) : (
              <Text style={styles.value}>
                {formatPrice(visit.priceGrosze, salon.currency, props.locale)}
              </Text>
            )}
          </>
        ) : null}

        {visit.note ? (
          <>
            <Text style={styles.label}>{v.note}</Text>
            <Text style={styles.value}>{visit.note}</Text>
          </>
        ) : null}

        {/* Task 80: what the client asked for when booking (the server shows them by permission). */}
        {wishes.length > 0 ? (
          <>
            <Text style={styles.label}>{v.wishes}</Text>
            {wishes.map((line) => (
              <Text key={line} style={styles.value}>
                {line}
              </Text>
            ))}
          </>
        ) : null}

        {photoFailure || photos?.items.length ? (
          <>
            <Text style={styles.label}>📷 {v.photos}</Text>
            {photoFailure ? (
              <>
                <ErrorText>{errorText(photoFailure.cause, t)}</ErrorText>
                <Button
                  kind="secondary"
                  label={t.day.refresh}
                  onPress={() => {
                    setPhotoFailure(null);
                    setPhotoAttempt((n) => n + 1);
                  }}
                />
              </>
            ) : null}
            <View style={styles.photos}>
              {photos?.items.map((p, i) => (
                <VisitPhoto
                  key={p.id}
                  uri={api.absoluteUrl(p.url)}
                  label={fill(v.photoAlt, { n: String(i + 1) })}
                  t={t}
                />
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
              void run('approve', (a) =>
                api.approve(salon.orgId, salon.locationId, a.id, a.version),
              )
            }
          />
        </>
      ) : null}
      {inlineError('approve')}
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
      {inlineError('status')}
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
      {inlineError('payment')}
      {props.canChange && visit.status === 'completed' ? (
        // Task 229: the tip — only a note for the report and "Kasa dnia".
        <View style={{ gap: 6 }} testID="tip-field">
          <Text style={styles.label}>{fill(v.tip, { currency: salon.currency })}</Text>
          <TextInput
            accessibilityLabel={fill(v.tip, { currency: salon.currency })}
            accessibilityHint={tipMessage ?? v.tipHint}
            aria-describedby="visit-tip-description"
            aria-invalid={tipValue === null}
            placeholder="0"
            keyboardType="decimal-pad"
            value={tipText ?? tipInput(visit.tipGrosze)}
            onChangeText={(text) => {
              setTipText(text);
              setActionError(null);
            }}
            editable={!busy}
            style={[styles.input, tipValue === null && styles.invalidInput]}
          />
          <View nativeID="visit-tip-description">
            {tipMessage ? (
              <ErrorText>{tipValue === null ? `! ${tipMessage}` : tipMessage}</ErrorText>
            ) : (
              <Text style={styles.muted}>{v.tipHint}</Text>
            )}
          </View>
          <View style={styles.row}>
            <Button
              kind="secondary"
              label={v.tipSave}
              busy={busy}
              disabled={tipValue === null || tipValue === visit.tipGrosze}
              onPress={() => {
                if (tipValue === null) return;
                void run('tip', (a) =>
                  api.setTip(salon.orgId, salon.locationId, a.id, a.version, tipValue),
                ).then((ok) => {
                  if (ok) setTipText(null);
                });
              }}
            />
          </View>
        </View>
      ) : visit.tipGrosze > 0 ? (
        <Text style={styles.value}>
          {fill(v.tipShown, {
            amount: formatPrice(visit.tipGrosze, salon.currency, props.locale),
          })}
        </Text>
      ) : null}
      {visit.status === 'confirmed' || visit.status === 'completed' ? (
        // Task Q3 (screen D): products the client put aside for this visit.
        <ToHandSection
          api={api}
          t={t}
          locale={props.locale}
          salon={salon}
          appointmentId={visit.id}
          canChange={props.canChange}
          completed={visit.status === 'completed'}
          onHanded={() => setSalesKey((k) => k + 1)}
        />
      ) : null}
      {visit.status === 'completed' || (props.canChange && visit.status === 'confirmed') ? (
        // Task 396: products the client bought at the visit.
        <ProductSalesSection
          completed={visit.status === 'completed'}
          key={salesKey}
          api={api}
          t={t}
          locale={props.locale}
          salon={salon}
          appointmentId={visit.id}
          canChange={props.canChange}
        />
      ) : null}
      {visit.status === 'completed' ? (
        // Task 542: the client pays the visit (or a part) with a gift voucher.
        <VisitVoucherSection
          api={api}
          t={t}
          locale={props.locale}
          salon={salon}
          appointmentId={visit.id}
          toPayGrosze={
            visit.priceGrosze === null ? null : visit.priceGrosze - (visit.discountGrosze ?? 0)
          }
          serviceName={visit.service.name}
        />
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
            disabled={busy}
            onPress={() => {
              setActionError(null);
              setTimes(null);
              setMode('move');
            }}
          />
          <Button
            kind="secondary"
            label={v.cancel}
            disabled={busy}
            onPress={() => {
              setActionError(null);
              setMode('cancel');
              setReasonSubmitted(false);
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
              disabled={busy || moveDate <= today}
              onPress={() => chooseMoveDate(addDays(moveDate, -1))}
            />
            <Text style={styles.dayName}>{dayTitle(moveDate, props.locale)}</Text>
            <Button
              kind="secondary"
              label="›"
              a11yLabel={v.nextDay}
              disabled={busy}
              onPress={() => chooseMoveDate(addDays(moveDate, 1))}
            />
          </View>
          {ask ? (
            <>
              <Text style={styles.value}>
                {fill(v.moveAsk, { when: `${dayTitle(moveDate, props.locale)} ${ask.time}` })}
              </Text>
              {inlineError('move')}
              <View style={styles.row}>
                <Button
                  label={v.yes}
                  busy={busy}
                  onPress={() =>
                    void run(
                      'move',
                      (a) =>
                        api.reschedule(salon.orgId, salon.locationId, a.id, a.version, ask.start),
                      clearMove,
                    ).then((ok) => {
                      if (!ok) return;
                      setMode(null);
                      setNotice(v.moved);
                    })
                  }
                />
                <Button
                  kind="secondary"
                  label={v.no}
                  disabled={busy}
                  onPress={() => setMoveDraft({ date: moveDate, start: null })}
                />
              </View>
            </>
          ) : timesError ? (
            <>
              <ErrorText>{timesError}</ErrorText>
              <Button
                kind="secondary"
                label={t.day.refresh}
                onPress={() => setTimesAttempt((n) => n + 1)}
              />
            </>
          ) : !times ? (
            <Text style={styles.muted}>{t.loading}</Text>
          ) : times.length === 0 ? (
            <Text style={styles.muted}>{v.noTimes}</Text>
          ) : (
            <View style={styles.times}>
              {times.map((s) => (
                <Pressable
                  accessibilityLabel={s.time}
                  key={s.start}
                  accessibilityRole="button"
                  onPress={() => {
                    setActionError(null);
                    setMoveDraft({ date: moveDate, start: s.start });
                  }}
                  style={styles.time}
                >
                  <Text style={styles.timeText}>{s.time}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <Button
            kind="link"
            label={v.close}
            disabled={busy}
            onPress={() => {
              clearMove();
              setMode(null);
            }}
          />
        </Card>
      ) : null}

      {mode === 'cancel' ? (
        <Card>
          <Text style={styles.label}>{v.reason}</Text>
          <TextInput
            accessibilityLabel={v.reason}
            accessibilityHint={reasonMessage}
            aria-describedby={reasonMessage ? 'visit-cancel-description' : undefined}
            aria-invalid={badReason}
            value={reason}
            maxLength={300}
            editable={!busy}
            onChangeText={(text) => {
              setActionError(null);
              setReason(text);
              setAskCancel(false);
            }}
            style={[styles.input, badReason && styles.invalidInput]}
          />
          {reasonMessage ? (
            <View nativeID="visit-cancel-description">
              <ErrorText>{badReason ? `! ${reasonMessage}` : reasonMessage}</ErrorText>
            </View>
          ) : null}
          {askCancel ? (
            <>
              <Text style={styles.value}>{v.cancelAsk}</Text>
              <View style={styles.row}>
                <Button
                  label={v.cancelYes}
                  busy={busy}
                  onPress={() =>
                    void run(
                      'cancel',
                      (a) =>
                        api.cancel(
                          salon.orgId,
                          salon.locationId,
                          a.id,
                          a.version,
                          cancelReason(reason) ?? '',
                        ),
                      clearReason,
                    ).then((ok) => {
                      if (!ok) return;
                      setMode(null);
                      setNotice(v.cancelled);
                    })
                  }
                />
                <Button
                  kind="secondary"
                  label={v.no}
                  disabled={busy}
                  onPress={() => setAskCancel(false)}
                />
              </View>
            </>
          ) : (
            <View style={styles.row}>
              <Button
                label={v.cancel}
                disabled={busy}
                onPress={() => {
                  setReasonSubmitted(true);
                  if (cancelReason(reason)) setAskCancel(true);
                }}
              />
              <Button
                kind="link"
                label={v.close}
                disabled={busy}
                onPress={() => {
                  clearReason();
                  setMode(null);
                }}
              />
            </View>
          )}
        </Card>
      ) : null}
    </ScrollView>
  );
}

function VisitPhoto({ uri, label, t }: { uri: string; label: string; t: Dictionary }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <View>
        <ErrorText>{t.error.network}</ErrorText>
        <Button
          kind="secondary"
          label={t.day.refresh}
          a11yLabel={`${t.day.refresh}: ${label}`}
          onPress={() => setFailed(false)}
        />
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={() => void Linking.openURL(uri)}
    >
      <Image
        source={{ uri }}
        accessibilityIgnoresInvertColors
        style={styles.photo}
        onError={() => setFailed(true)}
      />
    </Pressable>
  );
}

const VisitHeader = memo(function VisitHeader({
  visit,
  v,
  timeZone,
  locale,
}: {
  visit: AppointmentDetail;
  v: Dictionary['visit'];
  timeZone: string;
  locale: Locale;
}) {
  return (
    <>
      <Heading>
        {visit.time}–{timeIn(visit.end, timeZone)}
      </Heading>
      <Text style={styles.muted}>{dayTitle(visit.date, locale)}</Text>

      <View style={styles.chips}>
        <Text style={[styles.chip, visit.status === 'no_show' && styles.chipBad]}>
          {v.status[visit.status]}
        </Text>
        {visit.awaitingApproval ? (
          <Text accessibilityLabel={v.awaitingApproval} style={[styles.chip, styles.chipStrong]}>
            ⏳ {v.awaitingApproval}
          </Text>
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
    </>
  );
});

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
    maxWidth: '100%',
  },
  chipBad: { backgroundColor: '#f6dcd9', color: colors.danger },
  chipStrong: { backgroundColor: colors.ink, color: '#ffffff' },
  label: { marginTop: 8, fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  value: { fontSize: 17, color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
  notice: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  dayName: { maxWidth: '100%', fontSize: 16, fontWeight: '600', color: colors.ink, flexShrink: 1 },
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
  invalidInput: { borderColor: colors.danger },
  invalidPrice: { borderColor: colors.danger, borderWidth: 1, padding: 8, borderRadius: 12 },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    backgroundColor: colors.card,
    color: colors.ink,
  },
});
