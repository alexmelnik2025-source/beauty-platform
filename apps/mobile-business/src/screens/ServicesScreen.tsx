import { useCallback, useEffect, useState } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ApiError, type BusinessApi, type Locale } from '../api';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  bookingProblem,
  durationText,
  movedOrder,
  priceInput,
  priceList,
  serviceChange,
  type Service,
  type ServiceGroup,
} from '../services';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 93: "Usługi" — the owner or a manager sees the price list by category and changes a
 * service's price, duration and "bookable online" from the phone; ↑ / ↓ set the order clients
 * see (task 253). New services, categories and
 * who performs a service stay in the cabinet (one line says so).
 */
export function ServicesScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const u = t.services;
  const [groups, setGroups] = useState<ServiceGroup[] | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ price: '', duration: '', active: true });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [services, categories] = await Promise.all([
        api.services(salon.orgId, salon.locationId),
        api.serviceCategories(salon.orgId, salon.locationId),
      ]);
      setGroups(priceList(services, categories));
      setError('');
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  function edit(service: Service) {
    setEditId(service.id);
    setForm({
      price: priceInput(service.priceGrosze),
      duration: String(service.durationMinutes),
      active: service.active,
    });
    setError('');
    setInfo('');
  }

  async function save(service: Service) {
    const checked = serviceChange(service, form);
    if (!checked.ok) return setError(u.problem[checked.problem]);
    if (!checked.change) {
      setEditId(null);
      return setInfo(u.nothing);
    }
    setBusy(true);
    try {
      await api.updateService(salon.orgId, salon.locationId, service.id, checked.change);
      setEditId(null);
      setInfo(fill(u.saved, { name: service.name }));
      setError('');
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setEditId(null);
        setError(u.conflict);
        await load();
      } else {
        setError(errorText(e, t));
      }
    } finally {
      setBusy(false);
    }
  }

  /** Task 253: a place up or down within the category — clients see the price list so. */
  async function move(service: Service, step: -1 | 1) {
    const order = groups ? movedOrder(groups, service.id, step) : null;
    if (!order || busy) return;
    setBusy(true);
    try {
      const services = await api.reorderServices(salon.orgId, salon.locationId, order);
      const categories = await api.serviceCategories(salon.orgId, salon.locationId);
      setGroups(priceList(services, categories));
      setInfo(u.orderSaved);
      setError('');
    } catch (e) {
      setError(errorText(e, t));
      await load();
    } finally {
      setBusy(false);
    }
  }

  const price = (hundredths: number) => formatPrice(hundredths, salon.currency, props.locale);

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={u.back} onPress={onBack} />
      </View>
      <Heading>{u.title}</Heading>
      {info ? (
        <Text role="status" style={styles.info}>
          {info}
        </Text>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}

      {groups === null ? (
        !error ? (
          <Text style={styles.muted}>{t.loading}</Text>
        ) : null
      ) : groups.length === 0 ? (
        <Text style={styles.muted}>{u.none}</Text>
      ) : (
        groups.map((group) => (
          <View key={group.name ?? '-'} style={{ gap: 10 }}>
            <Text role="heading" aria-level={2} style={styles.section}>
              {group.name ?? u.other}
            </Text>
            {group.services.map((service, index) => {
              const problem = bookingProblem(service);
              const open = editId === service.id;
              return (
                <Card key={service.id}>
                  <Text style={[styles.name, !service.active && { color: colors.muted }]}>
                    {service.name}
                  </Text>
                  <Text style={styles.text}>
                    {`${price(service.priceGrosze)} · ${durationText(service.durationMinutes, u.units)}`}
                  </Text>
                  {problem ? (
                    <Text style={styles.warn}>{problem === 'hidden' ? u.hidden : u.nobody}</Text>
                  ) : null}
                  {open ? (
                    <View style={{ gap: 10, marginTop: 6 }}>
                      <Text style={styles.label}>
                        {fill(u.price, { currency: salon.currency })}
                      </Text>
                      <TextInput
                        accessibilityLabel={fill(u.price, { currency: salon.currency })}
                        value={form.price}
                        onChangeText={(price) => setForm((f) => ({ ...f, price }))}
                        keyboardType="decimal-pad"
                        style={styles.input}
                      />
                      <Text style={styles.label}>{u.duration}</Text>
                      <TextInput
                        accessibilityLabel={u.duration}
                        value={form.duration}
                        onChangeText={(duration) => setForm((f) => ({ ...f, duration }))}
                        keyboardType="number-pad"
                        style={styles.input}
                      />
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityLabel={u.active}
                        accessibilityState={{ checked: form.active }}
                        onPress={() => setForm((f) => ({ ...f, active: !f.active }))}
                        style={styles.check}
                      >
                        <Text style={[styles.box, form.active && styles.boxOn]}>
                          {form.active ? '✓' : ''}
                        </Text>
                        <Text style={[styles.text, { flexShrink: 1 }]}>{u.active}</Text>
                      </Pressable>
                      <View style={styles.row}>
                        <Button label={u.save} busy={busy} onPress={() => void save(service)} />
                        <Button kind="secondary" label={u.cancel} onPress={() => setEditId(null)} />
                      </View>
                    </View>
                  ) : (
                    <View style={styles.row}>
                      <Button
                        kind="link"
                        label={u.edit}
                        a11yLabel={`${u.edit}: ${service.name}`}
                        onPress={() => edit(service)}
                      />
                      {index > 0 ? (
                        <Button
                          kind="link"
                          label="↑"
                          a11yLabel={fill(u.up, { name: service.name })}
                          onPress={() => void move(service, -1)}
                        />
                      ) : null}
                      {index < group.services.length - 1 ? (
                        <Button
                          kind="link"
                          label="↓"
                          a11yLabel={fill(u.down, { name: service.name })}
                          onPress={() => void move(service, 1)}
                        />
                      ) : null}
                    </View>
                  )}
                </Card>
              );
            })}
          </View>
        ))
      )}
      {groups && groups.length > 0 ? <Text style={styles.muted}>{u.hint}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  section: { fontSize: 18, fontWeight: '700', color: colors.ink, marginTop: 8 },
  name: { fontSize: 17, fontWeight: '600', color: colors.ink },
  text: { fontSize: 15, color: colors.ink },
  label: { fontSize: 13, fontWeight: '700', color: colors.muted },
  muted: { color: colors.muted, fontSize: 15 },
  warn: { color: colors.danger, fontSize: 14 },
  info: { color: '#2e7d32', fontSize: 15 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.ink,
  },
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
});
