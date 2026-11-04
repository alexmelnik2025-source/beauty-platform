import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BackHandler,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  addDays,
  ApiError,
  todayIn,
  type BookingConfirmed,
  type ClientApi,
  type Hold,
  type Locale,
  type PublicLocation,
  type Slot,
  type SpokenLanguage,
} from '../api';
import {
  afterBookingError,
  BOOKING_DAYS,
  bookingStart,
  checkContact,
  countdown,
  dayParts,
  legalUrl,
  manageUrl,
  filterLanguages,
  priceRows,
  speakingStaff,
  staffFor,
  type BookingPreset,
  type BookingStep,
  type ContactForm,
  type ContactProblem,
} from '../booking';
import { WEB_URL } from '../config';
import { WishesPicker } from '../WishesPicker';
import { asksWishes, NO_WISHES, wishesToSend, type VisitWishes } from '../wishes';
import { errorText } from '../errors';
import {
  ANY_STAFF,
  dayChip,
  formatDay,
  formatPrice,
  servicePriceText,
  nearestByStaff,
  nearestText,
  slotsByDay,
} from '../format';
import { fill, type Dictionary } from '../i18n';
import { dialForTimeZone } from '../phone';
import { durationText, serviceGroups, specialtyText } from '../salon';
import { Button, Card, Chip, colors, ErrorText, Heading } from '../ui';
import { WaitlistPanel } from './WaitlistPanel';

/** A booking error in the client's words (the same texts as the web booking page). */
function bookingErrorText(error: unknown, t: Dictionary): string {
  if (error instanceof ApiError) {
    if (error.code === 'HOLD_EXPIRED' || error.code === 'NOT_FOUND') return t.book.HOLD_EXPIRED;
    if (error.code === 'TOO_MANY_ATTEMPTS') return t.book.TOO_MANY_ATTEMPTS;
    if (error.code === 'TOO_MANY_CODES') return t.book.TOO_MANY_CODES;
    if (error.code === 'CODE_EXPIRED' || error.code === 'CODE_NOT_SENT') {
      return t.signIn.newCodeNeeded;
    }
  }
  return errorText(error, t);
}

const PROBLEM_TEXT: Record<ContactProblem, (t: Dictionary) => string> = {
  name: (t) => t.book.badName,
  phone: (t) => t.book.badPhone,
  email: (t) => t.book.badEmail,
  terms: (t) => t.book.termsNeeded,
};

/**
 * Booking in the app, without an account: service → specialist (or anyone) → a free time,
 * held for 10 minutes → name, phone, email and the salon's booking rules → the code from the
 * email → booked. The same API and rules as the web booking page. "Book again" starts with the
 * same service and specialist (`preset`); "back" from there returns to where it was opened.
 */
export function BookingScreen(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  salon: PublicLocation;
  /** Signed in: the email is filled in, and the visit appears in "My visits". */
  email?: string;
  signedIn: boolean;
  /** Start with this service (and specialist): "Book again" or "Book" on a loyalty card. */
  preset?: BookingPreset;
  onBack: () => void;
  /** After booking: to "My visits" (signed in) or to sign-in with this email. */
  onFinished: (email: string) => void;
}) {
  const { api, t, locale, salon } = props;
  const b = t.book;
  const [start] = useState(() => bookingStart(salon, props.preset));
  const [step, setStep] = useState<BookingStep>(start.step);
  const [serviceId, setServiceId] = useState(start.serviceId);
  const [staffId, setStaffId] = useState<string | undefined>(start.staffId);
  /** Task 70c: a price line of several specialists — "any of these", or one picked over the times. */
  const [rowStaff, setRowStaff] = useState<string[]>([]);
  /** Came from a price line straight to the times: "back" returns to the price list. */
  const [fromList, setFromList] = useState(false);
  /** Task 80: the client's wishes, asked on the code step when the salon asks anything. */
  const [wishes, setWishes] = useState<VisitWishes>(NO_WISHES);
  /** Task 81: "Speaks EN" — only the specialists who speak the chosen language. */
  const [speaks, setSpeaks] = useState<SpokenLanguage | null>(null);
  // Shown until the client picks something: the service or specialist is no longer online.
  const [gone, setGone] = useState(start.gone);
  const presetStep = props.preset && start.step !== 'service' ? start.step : null;
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [day, setDay] = useState('');
  const [hold, setHold] = useState<Hold | null>(null);
  const [form, setForm] = useState<ContactForm>({
    name: '',
    phone: `+${dialForTimeZone(salon.timezone)} `,
    email: props.email ?? '',
    acceptTerms: false,
    marketingConsent: false,
  });
  const [code, setCode] = useState('');
  const [done, setDone] = useState<BookingConfirmed | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const holdRef = useRef<Hold | null>(null);
  holdRef.current = hold;
  const doneRef = useRef(false);
  doneRef.current = done !== null;

  const service = salon.services.find((s) => s.id === serviceId);
  const staffList = staffFor(salon, serviceId);
  const languages = filterLanguages(staffList);
  const activeSpeaks = speaks && languages.includes(speaks) ? speaks : null;
  const shownStaff = speakingStaff(staffList, activeSpeaks);
  /** Task 62: specialists' own prices — each one's price is shown when they differ. */
  const pricesDiffer = !!service && service.priceFromGrosze < service.priceToGrosze;
  const staffPrice = (id: string): number =>
    salon.staff.find((s) => s.id === id)?.prices.find((p) => p.serviceId === serviceId)
      ?.priceGrosze ??
    service?.priceGrosze ??
    0;

  const loadSlots = useCallback(async () => {
    setSlots(null);
    const from = todayIn(salon.timezone);
    try {
      const res = await api.availability(salon.slug, {
        serviceId,
        staffId,
        ...(!staffId && rowStaff.length > 1 ? { staffIds: rowStaff } : {}),
        from,
        to: addDays(from, BOOKING_DAYS - 1),
      });
      setSlots(res.slots);
      setDay((current) =>
        current && res.slots.some((s) => s.date === current) ? current : (res.slots[0]?.date ?? ''),
      );
    } catch (e) {
      setSlots([]);
      setError(bookingErrorText(e, t));
    }
  }, [api, salon.slug, salon.timezone, serviceId, staffId, rowStaff, t]);

  useEffect(() => {
    if (step === 'time') void loadSlots();
  }, [step, loadSlots]);

  // Task 12: each specialist's nearest free time on the "who" step ("Today from 14:30").
  const [nearest, setNearest] = useState<Map<string, Slot> | null>(null);
  useEffect(() => {
    if (step !== 'staff' || !serviceId) return;
    let live = true;
    setNearest(null);
    const from = todayIn(salon.timezone);
    api
      .availability(salon.slug, { serviceId, from, to: addDays(from, BOOKING_DAYS - 1) })
      .then((res) => {
        if (live) setNearest(nearestByStaff(res.slots));
      })
      // Only a hint: the specialists are there to pick without it.
      .catch(() => {
        if (live) setNearest(new Map());
      });
    return () => {
      live = false;
    };
  }, [api, step, serviceId, salon.slug, salon.timezone]);

  function nearestFree(id: string): string | undefined {
    if (nearest === null) return undefined;
    const today = todayIn(salon.timezone);
    return nearestText(nearest.get(id), { today, tomorrow: addDays(today, 1) }, b, locale);
  }

  // The countdown of the held time; when it runs out, the client picks a time again.
  useEffect(() => {
    if (!hold || (step !== 'details' && step !== 'code')) return;
    const timer = setInterval(() => {
      if (Date.parse(hold.expiresAt) <= Date.now()) {
        clearInterval(timer);
        setHold(null);
        setError(t.book.HOLD_EXPIRED);
        setStep('time');
      } else {
        tick((n) => n + 1);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [hold, step, t]);

  // Leaving the booking gives the held time back to the salon.
  useEffect(
    () => () => {
      if (holdRef.current && !doneRef.current) void api.releaseHold(holdRef.current);
    },
    [api],
  );

  const goBack = useCallback(() => {
    setError('');
    if (step === presetStep) props.onBack();
    else if (step === 'staff') setStep('service');
    else if (step === 'time') setStep(staffList.length > 1 && !fromList ? 'staff' : 'service');
    else if (step === 'details') setStep('time');
    else if (step === 'code') setStep('details');
    else props.onBack();
  }, [step, staffList.length, props, presetStep, fromList]);

  // Android "back" goes one step back.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 'done') return false;
      goBack();
      return true;
    });
    return () => sub.remove();
  }, [goBack, step]);

  /** Task 70c: "Book" on a price line — its one specialist, or "any of these" with circles. */
  function pickRow(id: string, row: string[]) {
    setServiceId(id);
    setError('');
    setGone(undefined);
    setStaffId(row.length === 1 ? row[0] : undefined);
    setRowStaff(row.length > 1 ? row : []);
    setFromList(true);
    setStep('time');
  }

  function pickService(id: string) {
    setServiceId(id);
    setError('');
    setGone(undefined);
    setRowStaff([]);
    setFromList(false);
    const who = staffFor(salon, id);
    // With one specialist there is nothing to choose.
    if (who.length === 1) {
      setStaffId(who[0]!.id);
      setStep('time');
    } else {
      setStaffId(undefined);
      setStep('staff');
    }
  }

  async function pickTime(slot: Slot) {
    setBusy(true);
    setError('');
    try {
      const created = await api.hold(salon.slug, {
        serviceId,
        ...(staffId ? { staffId } : rowStaff.length > 1 ? { staffIds: rowStaff } : {}),
        start: slot.start,
        ...(hold ? { releaseHoldToken: hold.holdToken } : {}),
      });
      setHold(created);
      setStep('details');
    } catch (e) {
      setError(bookingErrorText(e, t));
      if (afterBookingError(e) === 'reloadTimes') await loadSlots();
    } finally {
      setBusy(false);
    }
  }

  function backToTimes(e: unknown) {
    setError(bookingErrorText(e, t));
    setHold(null);
    setCode('');
    setStep('time');
  }

  async function sendCode() {
    if (!hold) return;
    const checked = checkContact(form, dialForTimeZone(salon.timezone));
    if (!checked.ok) return setError(PROBLEM_TEXT[checked.problem](t));
    setBusy(true);
    setError('');
    try {
      await api.sendBookingCode(hold, checked.contact, locale);
      setForm((f) => ({ ...f, email: checked.contact.email }));
      setCode('');
      setStep('code');
    } catch (e) {
      if (afterBookingError(e) === 'pickTimeAgain') backToTimes(e);
      else setError(bookingErrorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!hold || code.length !== 6) return;
    setBusy(true);
    setError('');
    try {
      const questions = salon.wishQuestions;
      setDone(
        await api.confirmBooking(
          hold,
          code,
          asksWishes(questions) ? wishesToSend(wishes, questions) : undefined,
        ),
      );
      setStep('done');
    } catch (e) {
      if (afterBookingError(e) === 'pickTimeAgain') backToTimes(e);
      else setError(bookingErrorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  const stepNames = [b.stepService, b.stepStaff, b.stepTime, b.stepDetails];
  const stepIndex = { service: 0, staff: 1, time: 2, details: 3, code: 3, done: 4 }[step];
  const days = slotsByDay(slots ?? []);
  const daySlots = days.find((d) => d.date === day)?.slots ?? [];

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      {step !== 'done' ? (
        <View style={styles.top}>
          <Button kind="link" label={b.back} onPress={goBack} disabled={busy} />
        </View>
      ) : null}
      <Text style={styles.brand}>{salon.name.toUpperCase()}</Text>
      {step !== 'done' ? (
        <>
          <Heading>{b.title}</Heading>
          <View style={styles.progress} role="list" aria-label={b.title}>
            {stepNames.map((name, i) => (
              <Text
                key={name}
                role="listitem"
                aria-selected={i === stepIndex}
                style={[
                  styles.progressStep,
                  i < stepIndex && styles.progressDone,
                  i === stepIndex && styles.progressNow,
                ]}
              >
                {name}
              </Text>
            ))}
          </View>
        </>
      ) : null}

      {service && step !== 'service' && step !== 'done' ? (
        <Card>
          <Text style={styles.strong}>{service.name}</Text>
          <Text style={styles.muted}>
            {durationText(service.durationMinutes, t.units)} ·{' '}
            {step === 'staff' || !staffId
              ? servicePriceText(service, salon.currency, locale, b.priceFrom)
              : formatPrice(staffPrice(staffId), salon.currency, locale)}
            {step !== 'staff'
              ? ` · ${staffList.find((s) => s.id === staffId)?.displayName ?? (hold?.staffName || b.anyStaff)}`
              : ''}
          </Text>
        </Card>
      ) : null}

      {presetStep && step === presetStep ? (
        <Button
          kind="link"
          label={b.otherService}
          disabled={busy}
          onPress={() => {
            setError('');
            setGone(undefined);
            setStep('service');
          }}
        />
      ) : null}
      {gone && (step === 'service' || step === 'staff' || step === 'time') ? (
        <Text role="note" style={styles.muted}>
          {gone === 'service' ? b.serviceGone : b.staffGone}
        </Text>
      ) : null}

      {error ? <ErrorText>{error}</ErrorText> : null}

      {step === 'service' ? (
        <View style={{ gap: 12 }}>
          <Text role="heading" aria-level={2} style={styles.section}>
            {b.pickService}
          </Text>
          {salon.services.length === 0 ? <Text style={styles.muted}>{b.salonClosed}</Text> : null}
          {serviceGroups(salon).map((g) => (
            <View key={g.id ?? 'other'} style={{ gap: 8 }}>
              {g.name || serviceGroups(salon).length > 1 ? (
                <Text style={styles.group}>{g.name ?? b.otherServices}</Text>
              ) : null}
              {g.services.map((s) => {
                const rows = priceRows(salon, s.id);
                const doing = staffFor(salon, s.id);
                // Everyone at one price and length: one "All specialists" line.
                const allOneRow = rows.length === 1 && doing.length > 1;
                return (
                  <View key={s.id} style={{ gap: 2 }}>
                    <Choice
                      title={s.name}
                      meta={durationText(s.durationMinutes, t.units)}
                      right={servicePriceText(s, salon.currency, locale, b.priceFrom)}
                      onPress={() => pickService(s.id)}
                    />
                    {rows.map((r) => {
                      const names = allOneRow
                        ? b.allStaff
                        : r.staff.map((x) => x.displayName).join(', ');
                      const offer = `${formatPrice(r.priceGrosze, salon.currency, locale)} · ${durationText(r.durationMinutes, t.units)}`;
                      return (
                        <Pressable
                          key={`${r.priceGrosze}|${r.durationMinutes}`}
                          accessibilityRole="button"
                          accessibilityLabel={`${fill(b.bookRow, { names })}, ${offer}`}
                          onPress={() =>
                            pickRow(
                              s.id,
                              r.staff.map((x) => x.id),
                            )
                          }
                          style={({ pressed }) => [styles.priceRow, pressed && { opacity: 0.7 }]}
                        >
                          <Text style={[styles.text, { flex: 1 }]}>{names}</Text>
                          <Text style={styles.muted}>{offer}</Text>
                          <Text style={styles.chevron}>›</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      ) : null}

      {step === 'staff' ? (
        <View style={{ gap: 8 }}>
          <Text role="heading" aria-level={2} style={styles.section}>
            {b.pickStaff}
          </Text>
          {languages.length > 0 ? (
            <View style={styles.chips} accessibilityLabel={b.speaksFilter}>
              <Text style={styles.muted}>{b.speaksFilter}</Text>
              <Chip
                label={b.speaksAll}
                pressed={activeSpeaks === null}
                onPress={() => setSpeaks(null)}
              />
              {languages.map((l) => (
                <Chip
                  key={l}
                  label={t.spoken[l]}
                  pressed={activeSpeaks === l}
                  onPress={() => setSpeaks(l)}
                />
              ))}
            </View>
          ) : null}
          {/* "Any specialist" could pick someone without the language: hidden while filtering. */}
          {activeSpeaks ? null : (
            <Choice
              title={b.anyStaff}
              meta={b.anyStaffHint}
              free={nearestFree(ANY_STAFF)}
              right={
                pricesDiffer && service
                  ? servicePriceText(service, salon.currency, locale, b.priceFrom)
                  : undefined
              }
              onPress={() => {
                setStaffId(undefined);
                setStep('time');
              }}
            />
          )}
          {shownStaff.map((s) => (
            <Choice
              key={s.id}
              title={s.displayName}
              meta={specialtyText(s, t.specialty) || undefined}
              free={nearestFree(s.id)}
              right={
                pricesDiffer ? formatPrice(staffPrice(s.id), salon.currency, locale) : undefined
              }
              onPress={() => {
                setStaffId(s.id);
                setStep('time');
              }}
            />
          ))}
        </View>
      ) : null}

      {step === 'time' ? (
        <View style={{ gap: 12 }}>
          <Text role="heading" aria-level={2} style={styles.section}>
            {b.pickTime}
          </Text>
          {rowStaff.length > 1 ? (
            // Task 70c: the line's specialists over the times, "Any" first (as on Booksy).
            <View style={styles.chips} accessibilityLabel={b.pickStaff}>
              <Chip label={b.anyShort} pressed={!staffId} onPress={() => setStaffId(undefined)} />
              {rowStaff.map((id) => {
                const who = salon.staff.find((x) => x.id === id);
                return who ? (
                  <Chip
                    key={id}
                    label={who.displayName}
                    pressed={staffId === id}
                    onPress={() => setStaffId(id)}
                  />
                ) : null;
              })}
            </View>
          ) : null}
          {slots === null ? (
            <Text style={styles.muted}>{t.visit.loadingSlots}</Text>
          ) : days.length === 0 ? (
            <Text style={styles.muted}>{b.noSlotsAtAll}</Text>
          ) : (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.days}
              >
                {days.map((d) => {
                  const chip = dayChip(d.date, locale);
                  const on = d.date === day;
                  return (
                    <Pressable
                      key={d.date}
                      accessibilityRole="button"
                      accessibilityLabel={formatDay(d.date, locale)}
                      aria-pressed={on}
                      onPress={() => setDay(d.date)}
                      style={[styles.dayChip, on && styles.dayChipOn]}
                    >
                      <Text style={[styles.dayWeek, on && styles.onText]}>{chip.weekday}</Text>
                      <Text style={[styles.dayNumber, on && styles.onText]}>{chip.day}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              {day ? <Text style={styles.strong}>{formatDay(day, locale)}</Text> : null}
              {daySlots.length === 0 ? <Text style={styles.muted}>{b.noSlotsDay}</Text> : null}
              {dayParts(daySlots).map((p) => (
                <View key={p.part} style={{ gap: 6 }}>
                  <Text style={styles.muted}>{b[p.part]}</Text>
                  <View style={styles.times}>
                    {p.slots.map((slot) => (
                      <Chip
                        key={slot.start}
                        // The salon's happy hours (task 16): at least this much off.
                        label={
                          slot.discountPercent
                            ? `${slot.time}  −${slot.discountPercent}%`
                            : slot.time
                        }
                        pressed={false}
                        onPress={() => {
                          if (!busy) void pickTime(slot);
                        }}
                      />
                    ))}
                  </View>
                </View>
              ))}
            </>
          )}
          {slots !== null && serviceId ? (
            <WaitlistPanel
              key={`${serviceId}-${staffId ?? ''}`}
              api={api}
              t={t}
              locale={locale}
              salon={salon}
              serviceId={serviceId}
              staffId={staffId}
              freeDates={days.map((d) => d.date)}
              signedIn={props.signedIn}
            />
          ) : null}
        </View>
      ) : null}

      {(step === 'details' || step === 'code') && hold ? (
        <Card>
          <Text style={styles.big}>
            {hold.time} · {formatDay(hold.date, locale)}
          </Text>
          <Text style={styles.text}>
            {hold.serviceName} · {hold.staffName} ·{' '}
            {hold.listPriceGrosze !== null ? (
              <Text style={{ textDecorationLine: 'line-through' }}>
                {formatPrice(hold.listPriceGrosze, hold.currency, locale)}
              </Text>
            ) : null}
            {hold.listPriceGrosze !== null ? ' ' : ''}
            {formatPrice(hold.priceGrosze, hold.currency, locale)}
            {hold.happyHourPercent ? ` −${hold.happyHourPercent}%` : ''}
          </Text>
          <Text style={styles.muted} aria-live="polite">
            {fill(b.heldFor, { time: countdown(hold.expiresAt) })}
          </Text>
          <View style={{ flexDirection: 'row', marginLeft: -8 }}>
            <Button
              kind="link"
              label={b.changeTime}
              disabled={busy}
              onPress={() => {
                setError('');
                setStep('time');
              }}
            />
          </View>
        </Card>
      ) : null}

      {step === 'details' && hold ? (
        <View style={{ gap: 12 }}>
          <Text role="heading" aria-level={2} style={styles.section}>
            {b.yourDetails}
          </Text>
          <Field label={b.name}>
            <TextInput
              accessibilityLabel={b.name}
              value={form.name}
              onChangeText={(name) => setForm({ ...form, name })}
              autoComplete="name"
              textContentType="name"
              style={styles.input}
            />
          </Field>
          <Field label={b.phone}>
            <TextInput
              accessibilityLabel={b.phone}
              value={form.phone}
              onChangeText={(phone) => setForm({ ...form, phone })}
              autoComplete="tel"
              textContentType="telephoneNumber"
              inputMode="tel"
              style={styles.input}
            />
          </Field>
          <Field label={b.email} hint={b.emailHint}>
            <TextInput
              accessibilityLabel={b.email}
              value={form.email}
              onChangeText={(email) => setForm({ ...form, email })}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              inputMode="email"
              style={styles.input}
            />
          </Field>
          <Check
            label={b.acceptTerms}
            checked={form.acceptTerms}
            onChange={(acceptTerms) => setForm({ ...form, acceptTerms })}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            <Button
              kind="link"
              label={b.termsLink}
              onPress={() => void Linking.openURL(legalUrl(WEB_URL, locale, salon.slug, 'terms'))}
            />
            <Button
              kind="link"
              label={b.privacyLink}
              onPress={() => void Linking.openURL(legalUrl(WEB_URL, locale, salon.slug, 'privacy'))}
            />
          </View>
          <Check
            label={b.marketing}
            checked={form.marketingConsent}
            onChange={(marketingConsent) => setForm({ ...form, marketingConsent })}
          />
          <Button label={b.sendCode} onPress={() => void sendCode()} busy={busy} />
        </View>
      ) : null}

      {step === 'code' && hold ? (
        <View style={{ gap: 12 }}>
          <Text role="heading" aria-level={2} style={styles.section}>
            {b.codeTitle}
          </Text>
          <Text style={styles.text}>{fill(b.codeLead, { email: form.email })}</Text>
          <TextInput
            accessibilityLabel={b.codeTitle}
            placeholder="000000"
            placeholderTextColor="#c9c3b8"
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            onSubmitEditing={() => void confirm()}
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            inputMode="numeric"
            maxLength={6}
            style={[styles.input, styles.code]}
          />
          {asksWishes(salon.wishQuestions) ? (
            <WishesPicker
              t={t}
              questions={salon.wishQuestions}
              value={wishes}
              onChange={setWishes}
            />
          ) : null}
          <Button
            label={b.confirm}
            onPress={() => void confirm()}
            busy={busy}
            disabled={code.length !== 6}
          />
          <Button kind="link" label={b.resend} disabled={busy} onPress={() => void sendCode()} />
        </View>
      ) : null}

      {step === 'done' && done ? (
        <View style={{ gap: 14 }}>
          <Text style={styles.doneMark} aria-hidden>
            ✓
          </Text>
          <Heading>{b.doneTitle}</Heading>
          <Text style={styles.text}>{b.doneLead}</Text>
          <Card>
            <Text style={styles.big}>
              {done.appointment.time} · {formatDay(done.appointment.date, locale)}
            </Text>
            <Text style={styles.text}>
              {done.appointment.service.name} · {done.appointment.staff.displayName}
            </Text>
            <Text style={styles.muted}>
              {salon.name}, {salon.addressLine}, {salon.city}
            </Text>
          </Card>
          {props.signedIn ? (
            <>
              <Text style={styles.text}>{b.inVisits}</Text>
              <Button label={b.toVisits} onPress={() => props.onFinished(form.email)} />
            </>
          ) : (
            <>
              <Text style={styles.text}>{b.signInLead}</Text>
              <Button label={b.signInButton} onPress={() => props.onFinished(form.email)} />
              <Button
                kind="secondary"
                label={b.manage}
                onPress={() => void Linking.openURL(manageUrl(WEB_URL, locale, done.manageToken))}
              />
            </>
          )}
        </View>
      ) : null}
    </ScrollView>
  );
}

function Choice(props: {
  title: string;
  meta?: string;
  /** The specialist's nearest free time (task 12). */
  free?: string;
  right?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[props.title, props.meta, props.free, props.right]
        .filter(Boolean)
        .join(', ')}
      onPress={props.onPress}
      style={({ pressed }) => [styles.choice, pressed && { opacity: 0.7 }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.strong}>{props.title}</Text>
        {props.meta ? <Text style={styles.muted}>{props.meta}</Text> : null}
        {props.free ? <Text style={styles.free}>{props.free}</Text> : null}
      </View>
      {props.right ? <Text style={styles.strong}>{props.right}</Text> : null}
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{props.label}</Text>
      {props.children}
      {props.hint ? <Text style={styles.muted}>{props.hint}</Text> : null}
    </View>
  );
}

function Check(props: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable
      role="checkbox"
      aria-checked={props.checked}
      accessibilityLabel={props.label}
      onPress={() => props.onChange(!props.checked)}
      style={styles.check}
    >
      <View style={[styles.box, props.checked && styles.boxOn]}>
        {props.checked ? <Text style={styles.boxMark}>✓</Text> : null}
      </View>
      <Text style={[styles.text, { flex: 1 }]}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 14 },
  top: { flexDirection: 'row', marginLeft: -8 },
  brand: { color: colors.gold, fontSize: 13, fontWeight: '700', letterSpacing: 2 },
  section: { color: colors.ink, fontSize: 18, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  group: { color: colors.gold, fontSize: 13, fontWeight: '700', letterSpacing: 1, marginTop: 4 },
  text: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  strong: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  free: { color: colors.ink, fontSize: 13, fontWeight: '600', marginTop: 2 },
  big: { color: colors.ink, fontSize: 20, fontWeight: '700' },
  label: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  progress: { flexDirection: 'row', gap: 6 },
  progressStep: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
    paddingVertical: 6,
    borderBottomWidth: 3,
    borderBottomColor: colors.line,
  },
  progressDone: { color: colors.ink, borderBottomColor: colors.gold },
  progressNow: { color: colors.ink, borderBottomColor: colors.ink },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 16,
  },
  chevron: { color: colors.muted, fontSize: 22 },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  days: { gap: 8, paddingVertical: 2 },
  dayChip: {
    width: 56,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    backgroundColor: colors.card,
  },
  dayChipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  dayWeek: { fontSize: 12, color: colors.muted, textTransform: 'capitalize' },
  dayNumber: { fontSize: 18, fontWeight: '700', color: colors.ink },
  onText: { color: '#fff' },
  times: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 17,
    color: colors.ink,
  },
  code: { fontSize: 28, letterSpacing: 8, textAlign: 'center' },
  check: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  box: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  boxOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  boxMark: { color: '#fff', fontSize: 14, fontWeight: '700' },
  doneMark: {
    alignSelf: 'flex-start',
    fontSize: 28,
    color: '#fff',
    backgroundColor: '#1e6b3a',
    width: 52,
    height: 52,
    lineHeight: 52,
    textAlign: 'center',
    borderRadius: 26,
    overflow: 'hidden',
  },
});
