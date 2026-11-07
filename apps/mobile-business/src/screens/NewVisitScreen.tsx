import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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
import { Button, Card, colors, ErrorText, Heading } from '../ui';
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
  const { api, t, salon, me, mineId, onBack } = props;
  const n = t.newVisit;
  const [services, setServices] = useState<ServiceList | null>(null);
  const [staff, setStaff] = useState<StaffList>([]);
  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState('');
  const firstDay = props.preset?.date ?? props.date;
  const [date, setDate] = useState(firstDay < props.today ? props.today : firstDay);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [start, setStart] = useState('');
  const [walkIn, setWalkIn] = useState(false);
  const [walkInDay, setWalkInDay] = useState(props.today);
  const [walkInTime, setWalkInTime] = useState('');
  const [paid, setPaid] = useState(false);
  /** Task 227: how the walk-in paid (optional). */
  const [paidWith, setPaidWith] = useState<PaymentMethod | null>(null);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<CustomerList | null>(null);
  const [client, setClient] = useState<Client>(props.preset?.customer ?? null);
  // Task 223: the time of the visit booked again, picked once if it is free on the first day.
  const wantedTime = useRef(props.preset?.time);
  const [form, setForm] = useState(props.preset?.client ?? { name: '', phone: '', email: '' });
  // Applied once, when the services and specialists have loaded.
  const preset = useRef(props.preset);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<ClientProblem | 'time' | 'client' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const searchable = maySearchClients(me);
  const mayMark =
    me.role !== 'staff' ||
    me.permissions.manageAllAppointments ||
    (me.permissions.changeOwnAppointments && staffId === mineId);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [list, team] = await Promise.all([
          api.services(salon.orgId, salon.locationId),
          api.staff(salon.orgId, salon.locationId),
        ]);
        if (!alive) return;
        const offered = activeServices(list);
        setServices(offered);
        setStaff(team);
        if (preset.current) {
          const choice = presetChoice(preset.current, offered, (id) =>
            staffForService(team, id, me, mineId),
          );
          preset.current = undefined;
          setServiceId(choice.serviceId);
          setStaffId(choice.staffId);
        }
      } catch (e) {
        if (alive) setError(errorText(e, t));
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, salon, t, me, mineId]);

  // Android "back" closes the form instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const who = serviceId ? staffForService(staff, serviceId, me, mineId) : [];

  const chooseService = (id: string) => {
    setServiceId(id);
    setStart('');
    const options = staffForService(staff, id, me, mineId);
    setStaffId(options.length === 1 ? options[0]!.id : '');
  };

  const loadTimes = useCallback(async () => {
    if (!serviceId || !staffId || walkIn) return;
    setAvailability(null);
    try {
      setAvailability(
        await api.availability(salon.orgId, salon.locationId, { serviceId, staffId, date }),
      );
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, serviceId, staffId, date, walkIn, t]);

  useEffect(() => {
    void loadTimes();
  }, [loadTimes]);

  useEffect(() => {
    if (!availability || !wantedTime.current) return;
    const same = freeTimes(availability, staffId, date).find((s) => s.time === wantedTime.current);
    wantedTime.current = undefined;
    if (same) setStart(same.start);
  }, [availability, staffId, date]);

  // Clients of the salon as the owner or manager types (from 2 characters).
  useEffect(() => {
    if (!searchable || search.trim().length < 2) {
      setFound(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void api
        .customers(salon.orgId, search.trim(), 20)
        .then((list) => alive && setFound(list))
        .catch(() => alive && setFound([]));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, salon, search, searchable]);

  async function save() {
    setProblem(null);
    setError('');
    let when = start;
    if (walkIn) {
      const time = parseTime(walkInTime);
      if (!time) return setProblem('time');
      when = localToInstant(walkInDay, time, props.timeZone);
    } else if (!when) {
      return setProblem('time');
    }
    let customer: { id: string } | { name: string; phone: string; email?: string };
    if (client) {
      customer = { id: client.id };
    } else {
      if (!form.name.trim() && !form.phone.trim()) return setProblem('client');
      const checked = checkNewClient(form, dialForTimeZone(props.timeZone));
      if (!checked.ok) return setProblem(checked.problem);
      customer = checked.customer;
    }
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
      props.onCreated(created);
    } catch (e) {
      const kind = createProblem(e);
      setError(kind === 'other' ? errorText(e, t) : n.problem[kind]);
      if (kind === 'taken') void loadTimes();
    } finally {
      setBusy(false);
    }
  }

  const service = services?.find((s) => s.id === serviceId);
  const specialist = staff.find((s) => s.id === staffId);
  const times = availability ? freeTimes(availability, staffId, date) : null;

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={n.back} onPress={onBack} />
      </View>
      <Heading>{n.title}</Heading>
      {error ? <ErrorText>{error}</ErrorText> : null}

      {/* 1. Service */}
      <Text style={styles.section}>{n.service}</Text>
      {!services ? (
        !error ? (
          <Text style={styles.muted}>{t.loading}</Text>
        ) : null
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
              <TextInput
                accessibilityLabel={n.startTime}
                placeholder={n.startTime}
                value={walkInTime}
                inputMode="numeric"
                maxLength={5}
                onChangeText={setWalkInTime}
                style={styles.input}
              />
              {problem === 'time' ? <ErrorText>{n.badTime}</ErrorText> : null}
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
              {!times ? (
                <Text style={styles.muted}>{t.loading}</Text>
              ) : times.length === 0 ? (
                <Text style={styles.muted}>{n.noTimes}</Text>
              ) : (
                <View style={styles.times}>
                  {times.map((s) => (
                    <Pressable
                      key={s.start}
                      accessibilityRole="button"
                      accessibilityState={{ selected: start === s.start }}
                      onPress={() => setStart(s.start)}
                      style={[styles.time, start === s.start && styles.timeChosen]}
                    >
                      <Text style={[styles.timeText, start === s.start && { color: '#fff' }]}>
                        {s.time}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
              {problem === 'time' ? <ErrorText>{n.pickTime}</ErrorText> : null}
            </>
          )}

          {/* 4. Client */}
          <Text style={styles.section}>{n.client}</Text>
          {client ? (
            <Chosen
              label={client.phone ? `${client.name} · ${client.phone}` : client.name}
              change={n.changeClient}
              onChange={() => setClient(null)}
            />
          ) : (
            <>
              {searchable ? (
                <>
                  <TextInput
                    accessibilityLabel={n.search}
                    placeholder={n.search}
                    value={search}
                    onChangeText={setSearch}
                    style={styles.input}
                  />
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
                        setClient({ id: c.id, name: c.name, phone: c.phone });
                        setSearch('');
                      }}
                    />
                  ))}
                </>
              ) : null}
              <Card>
                <Text style={styles.label}>{n.newClient}</Text>
                <TextInput
                  accessibilityLabel={n.name}
                  placeholder={n.name}
                  value={form.name}
                  maxLength={100}
                  onChangeText={(name) => setForm({ ...form, name })}
                  style={styles.input}
                />
                {problem === 'name' ? <ErrorText>{n.badName}</ErrorText> : null}
                <TextInput
                  accessibilityLabel={n.phone}
                  placeholder={`${n.phone} (+${dialForTimeZone(props.timeZone)})`}
                  value={form.phone}
                  inputMode="tel"
                  maxLength={20}
                  onChangeText={(phone) => setForm({ ...form, phone })}
                  style={styles.input}
                />
                {problem === 'phone' ? <ErrorText>{n.badPhone}</ErrorText> : null}
                <TextInput
                  accessibilityLabel={n.email}
                  placeholder={n.email}
                  value={form.email}
                  inputMode="email"
                  autoCapitalize="none"
                  maxLength={254}
                  onChangeText={(email) => setForm({ ...form, email })}
                  style={styles.input}
                />
                {problem === 'email' ? <ErrorText>{n.badEmail}</ErrorText> : null}
              </Card>
              {problem === 'client' ? <ErrorText>{n.pickClient}</ErrorText> : null}
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
          <Button label={n.save} busy={busy} onPress={() => void save()} />
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
