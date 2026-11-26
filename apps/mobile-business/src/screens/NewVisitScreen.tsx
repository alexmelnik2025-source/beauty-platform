import { useClearFormDraft, useFormDraft } from '../formDrafts';
import { FieldGroup, FormField } from '../formFields';
import { useEffect, useRef, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type {
  AppointmentDetail,
  Availability,
  BusinessApi,
  CustomerList,
  Locale,
  ServiceList,
  StaffList,
} from '../api';
import { addDays, dayTitle, formatPrice } from '../day';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import {
  activeServices,
  checkNewClient,
  createProblem,
  freeTimes,
  localToInstant,
  maySearchClients,
  newAppointmentBody,
  parseTime,
  staffForService,
  walkInDays,
  type ClientProblem,
  type MyRights,
} from '../newVisit';
import { dialForTimeZone } from '../phone';
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
import { presetChoice, type NewVisitPreset } from '../waitlist';
import type { SalonChoice } from './SalonsScreen';
import { PaymentMethodPicker } from './PaymentMethodPicker';
import type { PaymentMethod } from '../payment';

type Client = { id: string; name: string; phone: string | null } | null;

/**
 * "New visit" (task 17a): service → specialist → day and free time (or "the client has already
 * been": today or yesterday, any time) → client (found in the base, or new) → save.
 * A specialist books only for themselves; the server checks every right and time again.
 */
export function NewVisitScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  timeZone: string;
  today: string;
  /** The day the calendar shows: new visits start there (not before today). */
  date: string;
  me: MyRights;
  mineId: string | null;
  /**
   * Task 94: a client from the waiting list — service, specialist, day and contacts filled in.
   * Task 223: "Umów ponownie" — the same, with the client from the base and the visit's time.
   */
  preset?: NewVisitPreset;
  onBack: () => void;
  onCreated: (visit: AppointmentDetail) => void;
}) {
  const { api, t, salon, me, mineId, onBack, preset } = props;
  const n = t.newVisit;
  // Rebooking has a customer ID. Waitlist presets only carry the entry's contact fields.
  const source = preset
    ? JSON.stringify([
        preset.customer ? 'rebook' : 'waitlist',
        preset.serviceId,
        preset.staffId,
        preset.date,
        preset.time,
        preset.customer?.id ?? [preset.client.name, preset.client.phone, preset.client.email],
      ])
    : 'manual';
  const draftKey = `newVisit.${source}.`;
  const clearDraft = useClearFormDraft(draftKey);
  const [services, setServices] = useState<ServiceList | null>(null);
  const [staff, setStaff] = useState<StaffList>([]);
  const [servicesError, setServicesError] = useState('');
  const [servicesRevision, setServicesRevision] = useState(0);
  const suggested =
    preset && services
      ? presetChoice(preset, services, (id) => staffForService(staff, id, me, mineId))
      : undefined;
  const [serviceId, setServiceId] = useFormDraft(
    `${draftKey}serviceId`,
    suggested?.serviceId ?? '',
  );
  const [staffId, setStaffId] = useFormDraft(`${draftKey}staffId`, suggested?.staffId ?? '');
  const firstDay = preset?.date ?? props.date;
  const [date, setDate] = useFormDraft(
    `${draftKey}date`,
    firstDay < props.today ? props.today : firstDay,
  );
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [timesRevision, setTimesRevision] = useState(0);
  const times = availability ? freeTimes(availability, staffId, date) : null;
  const suggestedStart = preset?.time && times?.find((slot) => slot.time === preset.time)?.start;
  const [start, setStart] = useFormDraft(`${draftKey}start`, suggestedStart ?? '');
  const [walkIn, setWalkIn] = useFormDraft(`${draftKey}walkIn`, false);
  const [walkInDay, setWalkInDay] = useFormDraft(`${draftKey}walkInDay`, props.today);
  const [walkInTime, setWalkInTime] = useFormDraft(`${draftKey}walkInTime`, '');
  const [paid, setPaid] = useFormDraft(`${draftKey}paid`, false);
  /** Task 227: how the walk-in paid (optional). */
  const [paidWith, setPaidWith] = useFormDraft<PaymentMethod | null>(`${draftKey}paidWith`, null);
  const [search, setSearch] = useFormDraft(`${draftKey}search`, '');
  const [found, setFound] = useState<CustomerList | null>(null);
  const [searchError, setSearchError] = useState('');
  const [searchRevision, setSearchRevision] = useState(0);
  const [clientId, setClientId] = useFormDraft<string | null>(
    `${draftKey}clientId`,
    preset?.customer?.id ?? null,
  );
  const [chosenClient, setChosenClient] = useState<Client>(null);
  const [clientError, setClientError] = useState('');
  const client =
    chosenClient?.id === clientId
      ? chosenClient
      : preset?.customer?.id === clientId
        ? preset.customer
        : null;
  const [name, setName] = useFormDraft(`${draftKey}name`, preset?.client.name ?? '');
  const [phone, setPhone] = useFormDraft(`${draftKey}phone`, preset?.client.phone ?? '');
  const [email, setEmail] = useFormDraft(`${draftKey}email`, preset?.client.email ?? '');
  const [note, setNote] = useFormDraft(`${draftKey}note`, '');
  const [problem, setProblem] = useState<ClientProblem | 'time' | 'client' | null>(null);
  const [timeError, setTimeError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const searchable = maySearchClients(me);
  const restoreClientId = searchable && !client ? clientId : null;
  const mayMark =
    me.role !== 'staff' ||
    me.permissions.manageAllAppointments ||
    (me.permissions.changeOwnAppointments && staffId === mineId);

  useEffect(() => {
    let alive = true;
    setServicesError('');
    void (async () => {
      try {
        const [list, team] = await Promise.all([
          api.services(salon.orgId, salon.locationId),
          api.staff(salon.orgId, salon.locationId),
        ]);
        if (!alive) return;
        setServices(activeServices(list));
        setStaff(team);
      } catch (e) {
        if (alive) setServicesError(errorText(e, t));
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, salon, t, servicesRevision]);

  // Android "back" closes the form instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!busy) onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack, busy]);

  const who = serviceId ? staffForService(staff, serviceId, me, mineId) : [];

  const chooseService = (id: string) => {
    setServiceId(id);
    setStart('');
    const options = staffForService(staff, id, me, mineId);
    setStaffId(options.length === 1 ? options[0]!.id : '');
  };

  useEffect(() => {
    setAvailability(null);
    if (!serviceId || !staffId || walkIn) return;
    let alive = true;
    void api.availability(salon.orgId, salon.locationId, { serviceId, staffId, date }).then(
      (result) => alive && setAvailability(result),
      (e) => alive && setError(errorText(e, t)),
    );
    return () => {
      alive = false;
    };
  }, [api, salon, serviceId, staffId, date, walkIn, t, timesRevision]);

  // Only the choice is drafted. Read the current name and visible phone when returning to it.
  useEffect(() => {
    if (!restoreClientId) return;
    let alive = true;
    setClientError('');
    void api.customer(salon.orgId, restoreClientId).then(
      ({ id, name, phone }) => alive && setChosenClient({ id, name, phone }),
      (e) => alive && setClientError(errorText(e, t)),
    );
    return () => {
      alive = false;
    };
  }, [api, salon.orgId, restoreClientId, t]);

  // Clients of the salon as the owner or manager types (from 2 characters).
  useEffect(() => {
    setFound(null);
    setSearchError('');
    const query = search.trim();
    if (!searchable || query.length < 2) return;
    let alive = true;
    const timer = setTimeout(() => {
      void api.customers(salon.orgId, query, 20).then(
        (list) => alive && setFound(list),
        (e) => alive && setSearchError(errorText(e, t)),
      );
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, salon.orgId, search, searchable, t, searchRevision]);

  async function save() {
    if (saving.current) return;
    setProblem(null);
    setTimeError('');
    setError('');
    let when = start;
    if (walkIn) {
      const time = parseTime(walkInTime);
      if (!time) return setProblem('time');
      when = localToInstant(walkInDay, time, props.timeZone);
    } else if (!times?.some((slot) => slot.start === when)) {
      return setProblem('time');
    }
    let customer: { id: string } | { name: string; phone: string; email?: string };
    if (client) {
      customer = { id: client.id };
    } else {
      if (!name.trim() && !phone.trim()) return setProblem('client');
      const checked = checkNewClient({ name, phone, email }, dialForTimeZone(props.timeZone));
      if (!checked.ok) return setProblem(checked.problem);
      customer = checked.customer;
    }
    saving.current = true;
    setBusy(true);
    try {
      const created = await api.createAppointment(
        salon.orgId,
        salon.locationId,
        newAppointmentBody({
          serviceId,
          staffId,
          start: when,
          client: customer,
          locale: props.locale,
          note,
          walkIn: walkIn ? { paid, method: paidWith } : null,
        }),
      );
      clearDraft();
      props.onCreated(created);
    } catch (e) {
      const kind = createProblem(e);
      if (kind === 'other' || kind === 'forbidden') {
        setError(kind === 'other' ? errorText(e, t) : n.problem.forbidden);
      } else {
        setTimeError(n.problem[kind]);
      }
      if (kind === 'taken') setTimesRevision((revision) => revision + 1);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  const service = services?.find((s) => s.id === serviceId);
  const specialist = who.find((s) => s.id === staffId);

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={n.back} disabled={busy} onPress={onBack} />
      </View>
      <Heading>{n.title}</Heading>
      {error ? <ErrorText>{error}</ErrorText> : null}

      {/* 1. Service */}
      <Text style={styles.section}>{n.service}</Text>
      {servicesError ? (
        <>
          <ErrorText>{servicesError}</ErrorText>
          <Button
            kind="secondary"
            label={t.day.refresh}
            onPress={() => setServicesRevision((r) => r + 1)}
          />
        </>
      ) : !services ? (
        <Text style={styles.muted}>{t.loading}</Text>
      ) : service ? (
        <Chosen
          label={`${service.name} · ${service.durationMinutes} ${t.visit.minutes}`}
          change={n.change}
          onChange={() => chooseService('')}
        />
      ) : services.length === 0 ? (
        <Text style={styles.muted}>{n.noServices}</Text>
      ) : (
        services.map((s) => (
          <Option
            key={s.id}
            label={s.name}
            detail={`${s.durationMinutes} ${t.visit.minutes} · ${formatPrice(s.priceGrosze, salon.currency, props.locale)}`}
            onPress={() => chooseService(s.id)}
          />
        ))
      )}

      {/* 2. Specialist */}
      {service ? (
        <>
          <Text style={styles.section}>{n.staff}</Text>
          {specialist ? (
            <Chosen
              label={specialist.displayName}
              change={who.length > 1 ? n.change : null}
              onChange={() => {
                setStaffId('');
                setStart('');
              }}
            />
          ) : who.length === 0 ? (
            <Text style={styles.muted}>{n.noStaff}</Text>
          ) : (
            who.map((s) => (
              <Option key={s.id} label={s.displayName} onPress={() => setStaffId(s.id)} />
            ))
          )}
        </>
      ) : null}

      {/* 3. Day and time */}
      {service && specialist ? (
        <>
          {mayMark ? (
            <Check
              label={n.walkIn}
              checked={walkIn}
              onPress={() => {
                setWalkIn(!walkIn);
                setStart('');
                setPaid(false);
              }}
            />
          ) : null}
          {walkIn ? (
            <Card>
              <Text style={styles.muted}>{n.walkInHint}</Text>
              <View style={styles.row}>
                {walkInDays(props.today).map((d, i) => (
                  <Button
                    key={d}
                    kind={walkInDay === d ? 'primary' : 'secondary'}
                    label={i === 0 ? n.today : n.yesterday}
                    onPress={() => setWalkInDay(d)}
                  />
                ))}
              </View>
              <FormField
                error={problem === 'time' ? n.badTime : timeError || undefined}
                accessibilityLabel={n.startTime}
                placeholder={n.startTime}
                value={walkInTime}
                inputMode="numeric"
                maxLength={5}
                onChangeText={(value) => {
                  setProblem(null);
                  setTimeError('');
                  setWalkInTime(value);
                }}
                style={styles.input}
              />
              <Check label={n.paid} checked={paid} onPress={() => setPaid(!paid)} />
              {paid ? <PaymentMethodPicker t={t} value={paidWith} onChange={setPaidWith} /> : null}
            </Card>
          ) : (
            <>
              <Text style={styles.section}>{n.day}</Text>
              <View style={styles.row}>
                <Button
                  kind="secondary"
                  label="‹"
                  a11yLabel={n.previousDay}
                  disabled={date <= props.today}
                  onPress={() => {
                    setDate(addDays(date, -1));
                    setStart('');
                  }}
                />
                <Text style={styles.dayName}>{dayTitle(date, props.locale)}</Text>
                <Button
                  kind="secondary"
                  label="›"
                  a11yLabel={n.nextDay}
                  onPress={() => {
                    setDate(addDays(date, 1));
                    setStart('');
                  }}
                />
              </View>
              <Text style={styles.section}>{n.time}</Text>
              <FieldGroup error={problem === 'time' ? n.pickTime : timeError || undefined}>
                {!times ? (
                  <Text style={styles.muted}>{t.loading}</Text>
                ) : times.length === 0 ? (
                  <Text style={styles.muted}>{n.noTimes}</Text>
                ) : (
                  <View style={styles.times}>
                    {times.map((s) => (
                      <Pressable
                        accessibilityLabel={s.time}
                        key={s.start}
                        accessibilityRole="button"
                        aria-pressed={start === s.start}
                        accessibilityState={{ selected: start === s.start }}
                        onPress={() => {
                          setProblem(null);
                          setTimeError('');
                          setStart(s.start);
                        }}
                        style={[styles.time, start === s.start && styles.timeChosen]}
                      >
                        <Text style={[styles.timeText, start === s.start && { color: '#fff' }]}>
                          {s.time}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </FieldGroup>
            </>
          )}

          {/* 4. Client */}
          <Text style={styles.section}>{n.client}</Text>
          {client ? (
            <Chosen
              label={client.phone ? `${client.name} · ${client.phone}` : client.name}
              change={n.changeClient}
              onChange={() => setClientId(null)}
            />
          ) : restoreClientId ? (
            <View>
              {clientError ? (
                <ErrorText>{clientError}</ErrorText>
              ) : (
                <Text style={styles.muted}>{t.loading}</Text>
              )}
              <Button kind="link" label={n.changeClient} onPress={() => setClientId(null)} />
            </View>
          ) : (
            <>
              {searchable ? (
                <>
                  <FormField
                    error={searchError || undefined}
                    accessibilityLabel={n.search}
                    placeholder={n.search}
                    value={search}
                    onChangeText={setSearch}
                    style={styles.input}
                  />
                  {searchError ? (
                    <Button
                      kind="secondary"
                      label={t.day.refresh}
                      onPress={() => setSearchRevision((r) => r + 1)}
                    />
                  ) : null}
                  {search.trim().length > 0 && search.trim().length < 2 ? (
                    <Text style={styles.muted}>{n.searchHint}</Text>
                  ) : null}
                  {found?.length === 0 ? <Text style={styles.muted}>{n.noResults}</Text> : null}
                  {found?.map((c) => (
                    <Option
                      key={c.id}
                      label={c.name}
                      detail={c.phone ?? c.email ?? undefined}
                      onPress={() => {
                        setChosenClient({ id: c.id, name: c.name, phone: c.phone });
                        setClientId(c.id);
                        setSearch('');
                      }}
                    />
                  ))}
                </>
              ) : null}
              <Card>
                <Text style={styles.label}>{n.newClient}</Text>
                <FormField
                  error={
                    problem === 'name' ? n.badName : problem === 'client' ? n.pickClient : undefined
                  }
                  accessibilityLabel={n.name}
                  placeholder={n.name}
                  value={name}
                  maxLength={100}
                  onChangeText={setName}
                  style={styles.input}
                />
                <FormField
                  error={problem === 'phone' ? n.badPhone : undefined}
                  accessibilityLabel={n.phone}
                  placeholder={`${n.phone} (+${dialForTimeZone(props.timeZone)})`}
                  value={phone}
                  inputMode="tel"
                  maxLength={20}
                  onChangeText={setPhone}
                  style={styles.input}
                />
                <FormField
                  error={problem === 'email' ? n.badEmail : undefined}
                  accessibilityLabel={n.email}
                  placeholder={n.email}
                  value={email}
                  inputMode="email"
                  autoCapitalize="none"
                  maxLength={254}
                  onChangeText={setEmail}
                  style={styles.input}
                />
              </Card>
            </>
          )}

          <TextInput
            accessibilityLabel={n.note}
            placeholder={n.note}
            value={note}
            maxLength={500}
            multiline
            onChangeText={setNote}
            style={[styles.input, { minHeight: 64 }]}
          />
          <Button
            label={n.save}
            busy={busy}
            disabled={!!restoreClientId}
            onPress={() => void save()}
          />
        </>
      ) : null}
    </ScrollView>
  );
}

function Option(props: { label: string; detail?: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.detail ? `${props.label} · ${props.detail}` : props.label}
      onPress={props.onPress}
      style={({ pressed }) => [styles.option, pressed && { opacity: 0.7 }]}
    >
      <Text style={styles.optionText}>{props.label}</Text>
      {props.detail ? <Text style={styles.muted}>{props.detail}</Text> : null}
    </Pressable>
  );
}

function Chosen(props: { label: string; change: string | null; onChange: () => void }) {
  return (
    <View style={[styles.option, styles.chosen]}>
      <Text style={[styles.optionText, { flexShrink: 1 }]}>✓ {props.label}</Text>
      {props.change ? <Button kind="link" label={props.change} onPress={props.onChange} /> : null}
    </View>
  );
}

function Check(props: { label: string; checked: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.checked }}
      onPress={props.onPress}
      style={styles.check}
    >
      <Text style={[styles.box, props.checked && styles.boxOn]}>{props.checked ? '✓' : ''}</Text>
      <Text style={[styles.optionText, { flexShrink: 1, fontWeight: '500' }]}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 10 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  section: {
    marginTop: 10,
    fontSize: 13,
    fontWeight: '700',
    color: colors.muted,
    letterSpacing: 1,
  },
  label: { fontSize: 13, fontWeight: '700', color: colors.muted },
  muted: { color: colors.muted, fontSize: 15 },
  dayName: { fontSize: 16, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  option: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 2,
  },
  chosen: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderColor: colors.accent,
  },
  optionText: { fontSize: 16, fontWeight: '600', color: colors.ink },
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
  timeChosen: { backgroundColor: colors.ink, borderColor: colors.ink },
  timeText: { fontSize: 16, fontWeight: '600', color: colors.ink },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  box: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 6,
    textAlign: 'center',
    lineHeight: 20,
    color: '#fff',
    fontWeight: '700',
  },
  boxOn: { backgroundColor: colors.ink },
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
