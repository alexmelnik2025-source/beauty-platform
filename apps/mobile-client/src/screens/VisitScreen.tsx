import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  ApiError,
  newRequestKey,
  todayIn,
  type ClientApi,
  type ClientAppointment,
  type Locale,
  type Slot,
  type VisitCoupons,
} from '../api';
import type { BookingPreset } from '../booking';
import { errorText } from '../errors';
import {
  dayChip,
  formatDay,
  formatMoment,
  formatPrice,
  salonAddress,
  slotsByDay,
  visitActions,
} from '../format';
import { fill, type Dictionary } from '../i18n';
import { directionsUrl } from '../salon';
import { shareSalon, visitShareMessage } from '../share';
import { shareTools } from './shareTools';
import { Button, Card, Chip, colors, ErrorText, Heading } from '../ui';
import { WishesPicker } from '../WishesPicker';
import { VisitPhotos } from '../WishPhotosPicker';
import { ReviewCard } from '../ReviewCard';
import { asksWishes, wishesToSend, type VisitWishes } from '../wishes';

/**
 * One visit: when, what, with whom, where and for how much; change the time or cancel (both
 * ask first, until the salon's deadline), pick one of my coupons, call the salon, book again.
 */
export function VisitScreen(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  /** The visit as the list showed it; refreshed from the server on opening. */
  visit: ClientAppointment;
  onBack: () => void;
  /** "Book again": the booking in the app with the same service and specialist. */
  onBook: (slug: string, name: string, preset: BookingPreset) => void;
  /** The visit changed (cancelled): the list reloads when the client goes back. */
  onChanged: () => void;
  onSessionEnded: () => void;
}) {
  const { api, t, locale, onBack, onSessionEnded } = props;
  const [visit, setVisit] = useState<ClientAppointment>(props.visit);
  const [wishDraft, setWishDraft] = useState<VisitWishes>(props.visit.wishes);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  /** "Change time": the specialist's free times (null while loading), the day and the time picked. */
  const [moving, setMoving] = useState(false);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [pickedDay, setPickedDay] = useState('');
  const [pending, setPending] = useState<Slot | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  // One key per "Yes": a second tap or a retry after a lost answer cancels once.
  const keyRef = useRef(newRequestKey());
  const moveKeyRef = useRef(newRequestKey());
  /** My coupons for this visit (task 10d): loaded while the visit can still be changed. */
  const [coupons, setCoupons] = useState<VisitCoupons | null>(null);

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

  /** Task 22: the phone opens the visit's .ics file and offers to add it to its calendar. */
  async function addToCalendar() {
    setError('');
    try {
      const { url } = await api.calendarLink(visit.id);
      await Linking.openURL(url);
    } catch (e) {
      if (!api.signedIn) return onSessionEnded();
      setError(errorText(e, t));
    }
  }

  /** Task 411: "Udostępnij wizytę" — when and where, with the route, for a friend or family. */
  const [shareInfo, setShareInfo] = useState('');
  async function shareVisit() {
    const content = visitShareMessage(
      t.visit.shareText,
      {
        service: visit.service.name,
        staff: visit.staff.displayName,
        day: formatDay(visit.date, locale),
        time: visit.time,
        salon: visit.salon.name,
        address: salonAddress(visit.salon),
      },
      directionsUrl(visit.salon, 'web'),
    );
    const result = await shareSalon(content, shareTools(), 'message');
    setShareInfo(
      result === 'copied' ? t.visit.shareCopied : result === 'failed' ? t.visit.shareFailed : '',
    );
  }

  // Android "back" closes the card instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (moving) setMoving(false);
      else onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack, moving]);

  // Free times of the same specialist, from today in the salon's time zone.
  const visitId = visit.id;
  const loadSlots = useCallback(
    async (target: ClientAppointment) => {
      setSlots(null);
      setPending(null);
      try {
        const res = await api.freeTimes(target, todayIn(target.timezone));
        const days = slotsByDay(res.slots, target);
        setSlots(res.slots);
        setPickedDay((current) =>
          days.some((d) => d.date === current) ? current : (days[0]?.date ?? ''),
        );
      } catch (e) {
        setSlots([]);
        setError(errorText(e, tRef.current));
      }
    },
    [api],
  );

  function startMoving() {
    setMoving(true);
    setAsking(false);
    setError('');
    setDone('');
    void loadSlots(visit);
  }

  async function move(slot: Slot) {
    setBusy(true);
    setError('');
    try {
      setVisit(await api.reschedule(visitId, slot.start, moveKeyRef.current));
      moveKeyRef.current = newRequestKey();
      setPending(null);
      setMoving(false);
      setDone(t.visit.moved);
      props.onChanged();
    } catch (e) {
      if (!api.signedIn) return onSessionEnded();
      setPending(null);
      setError(errorText(e, t));
      moveKeyRef.current = newRequestKey();
      if (e instanceof ApiError && e.code === 'TOO_LATE_TO_CHANGE') {
        setMoving(false);
        await refresh();
      } else {
        // Someone took the time meanwhile: show what is free now.
        await loadSlots(visit);
      }
    } finally {
      setBusy(false);
    }
  }

  const couponsOpen = visit.status === 'confirmed' && visit.canChange;
  useEffect(() => {
    if (!couponsOpen) return;
    let live = true;
    api
      .visitCoupons(visitId)
      .then((data) => {
        if (live) setCoupons(data);
      })
      // Without the list the visit still works; coupons are simply not offered.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, visitId, couponsOpen, visit.discountGrosze]);

  async function changeCoupon(action: () => Promise<ClientAppointment>) {
    setBusy(true);
    setError('');
    setDone('');
    try {
      setVisit(await action());
      props.onChanged();
    } catch (e) {
      if (!api.signedIn) return onSessionEnded();
      setError(errorText(e, t));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

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

  /** Task 80: change the wishes until the visit starts. */
  async function saveWishes(wishes: VisitWishes) {
    if (!asksWishes(visit.wishQuestions)) return;
    setBusy(true);
    setError('');
    setDone('');
    try {
      const saved = await api.updateWishes(visit.id, wishesToSend(wishes, visit.wishQuestions));
      setVisit(saved);
      setWishDraft(saved.wishes);
      setDone(t.wishStep.saved);
    } catch (e) {
      if (!api.signedIn) return onSessionEnded();
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  const v = t.visit;
  const day = formatDay(visit.date, locale);
  const actions = visitActions(visit);
  const again = visit.bookAgain;
  const address = salonAddress(visit.salon);
  const faded = visit.status === 'cancelled' || visit.status === 'expired';
  const days = slotsByDay(slots ?? [], visit);

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
          {visit.awaitingApproval ? `⏳ ${t.visits.waiting}` : t.visits.status[visit.status]}
        </Text>
      </View>

      {visit.awaitingApproval ? <Text style={styles.value}>{t.visit.waitingLead}</Text> : null}
      {done ? (
        <Text role="status" style={styles.done}>
          {done}
        </Text>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}

      <Card>
        <Row label={v.staff} value={visit.staff.displayName} />
        <Row label={v.duration} value={`${visit.service.durationMinutes} ${t.visits.minutes}`} />
        <Row
          label={v.price}
          value={formatPrice(visit.service.priceGrosze, visit.currency, locale)}
        />
        {visit.coupons.map((c) => (
          <Row
            key={c.id}
            label={`${v.couponUsed}: ${c.name}`}
            value={`−${formatPrice(c.discountGrosze, visit.currency, locale)}`}
          />
        ))}
        {visit.discountGrosze > 0 ? (
          <Row
            label={v.toPay}
            value={formatPrice(
              visit.service.priceGrosze - visit.discountGrosze,
              visit.currency,
              locale,
            )}
          />
        ) : null}
      </Card>

      {visit.canChangeWishes && asksWishes(visit.wishQuestions) ? (
        <View style={{ gap: 8 }}>
          <WishesPicker
            t={t}
            questions={visit.wishQuestions}
            value={wishDraft}
            onChange={setWishDraft}
          />
          <Button
            kind="secondary"
            label={t.wishStep.save}
            busy={busy}
            onPress={() => void saveWishes(wishDraft)}
          />
        </View>
      ) : null}

      <VisitPhotos t={t} api={api} locale={locale} visit={visit} />

      {couponsOpen && coupons && (coupons.applied.length > 0 || coupons.available.length > 0) ? (
        <View role="region" aria-label={v.coupons} style={styles.move}>
          <Text role="heading" aria-level={2} style={styles.moveTitle}>
            {v.coupons}
          </Text>
          {coupons.applied.map((c) => (
            <View key={c.id} style={styles.couponRow}>
              <Text style={styles.couponName}>✓ {c.name}</Text>
              <Button
                kind="link"
                label={v.couponRemove}
                disabled={busy}
                onPress={() => void changeCoupon(() => api.dropCoupon(visit.id, c.id))}
              />
            </View>
          ))}
          {coupons.available.length > 0 ? <Text style={styles.muted}>{v.couponsHint}</Text> : null}
          {coupons.available.map((c) => (
            <View key={c.id} style={styles.couponRow}>
              <Text style={styles.couponName}>
                {c.name}
                {c.problem ? (
                  <Text style={styles.muted}> · {v.couponProblem[c.problem]}</Text>
                ) : null}
              </Text>
              {c.problem ? null : (
                <Button
                  kind="secondary"
                  label={`${v.couponUse}${
                    c.discountGrosze !== null
                      ? ` −${formatPrice(c.discountGrosze, visit.currency, locale)}`
                      : ''
                  }`}
                  disabled={busy}
                  onPress={() => void changeCoupon(() => api.useCoupon(visit.id, c.id))}
                />
              )}
            </View>
          ))}
        </View>
      ) : null}

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

      {actions.move && !moving && !asking ? <Button label={v.move} onPress={startMoving} /> : null}
      {actions.move && moving ? (
        <View style={styles.move}>
          <Text role="heading" aria-level={2} style={styles.moveTitle}>
            {v.moveTitle}
          </Text>
          <Text style={styles.muted}>{fill(v.moveLead, { staff: visit.staff.displayName })}</Text>
          {slots === null ? (
            <Text role="status" style={styles.muted}>
              {v.loadingSlots}
            </Text>
          ) : days.length === 0 ? (
            <Text style={styles.muted}>{v.noSlots}</Text>
          ) : (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.days}
              >
                {days.map((d) => {
                  const chip = dayChip(d.date, locale);
                  const on = d.date === pickedDay;
                  return (
                    <Pressable
                      key={d.date}
                      accessibilityRole="button"
                      accessibilityLabel={formatDay(d.date, locale)}
                      aria-pressed={on}
                      disabled={busy}
                      onPress={() => {
                        setPickedDay(d.date);
                        setPending(null);
                      }}
                      style={[styles.dayChip, on && styles.dayChipOn]}
                    >
                      <Text style={[styles.dayWeek, on && styles.onText]}>{chip.weekday}</Text>
                      <Text style={[styles.dayNumber, on && styles.onText]}>{chip.day}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <View style={styles.times}>
                {(days.find((d) => d.date === pickedDay)?.slots ?? []).map((slot) => (
                  <Chip
                    key={slot.start}
                    label={slot.time}
                    pressed={pending?.start === slot.start}
                    onPress={() => {
                      if (!busy) setPending(slot);
                    }}
                  />
                ))}
              </View>
            </>
          )}
          {pending ? (
            <View role="alertdialog" aria-label={v.move} style={[styles.ask, styles.askMove]}>
              <Text style={styles.askText}>
                {fill(v.moveAsk, { day: formatDay(pending.date, locale), time: pending.time })}
              </Text>
              <View style={styles.askButtons}>
                <View style={{ flex: 1 }}>
                  <Button
                    kind="secondary"
                    label={v.moveNo}
                    disabled={busy}
                    onPress={() => setPending(null)}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button label={v.moveYes} busy={busy} onPress={() => void move(pending)} />
                </View>
              </View>
            </View>
          ) : null}
          <Button
            kind="link"
            label={v.moveClose}
            disabled={busy}
            onPress={() => {
              setMoving(false);
              setPending(null);
            }}
          />
        </View>
      ) : null}

      {actions.cancel && !asking && !moving ? (
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

      {visit.status === 'completed' || visit.status === 'confirmed' ? (
        <ReviewCard
          key={`review-${visit.id}-${visit.status}`}
          api={api}
          t={t}
          locale={locale}
          visitId={visit.id}
          staffName={visit.staff.displayName}
        />
      ) : null}

      {visit.status === 'confirmed' && !moving ? (
        <Button
          kind="secondary"
          label={v.addToCalendar}
          disabled={busy}
          onPress={() => void addToCalendar()}
        />
      ) : null}
      {visit.salon.phone ? (
        <Button
          kind="secondary"
          label={`${v.callSalon} ${visit.salon.phone}`}
          onPress={() => void Linking.openURL(`tel:${visit.salon.phone}`)}
        />
      ) : null}
      {visit.status === 'confirmed' && !moving ? (
        <Button kind="secondary" label={v.share} onPress={() => void shareVisit()} />
      ) : null}
      {shareInfo ? (
        <Text role="status" style={styles.muted}>
          {shareInfo}
        </Text>
      ) : null}
      {visit.status === 'confirmed' ? (
        <Button
          kind="secondary"
          label={v.directions}
          onPress={() => void Linking.openURL(directionsUrl(visit.salon, Platform.OS))}
        />
      ) : null}
      {again ? (
        <>
          <Button
            label={v.bookAgain}
            onPress={() =>
              props.onBook(again.slug, visit.salon.name, {
                serviceId: again.serviceId,
                staffId: again.staffId,
              })
            }
          />
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
  askMove: { borderColor: colors.ink },
  move: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 16,
    gap: 12,
  },
  moveTitle: { fontSize: 18, fontWeight: '700', color: colors.ink },
  couponRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
  },
  couponName: { fontSize: 15, color: colors.ink, flexShrink: 1 },
  days: { gap: 8, paddingVertical: 2 },
  dayChip: {
    width: 56,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  dayChipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  dayWeek: { fontSize: 12, color: colors.muted, textTransform: 'capitalize' },
  dayNumber: { fontSize: 18, fontWeight: '700', color: colors.ink },
  onText: { color: '#fff' },
  times: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
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
