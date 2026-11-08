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
import {
  ApiError,
  type BusinessApi,
  type Locale,
  type ServiceCategoryList,
  type StaffList,
} from '../api';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  bookingProblem,
  categoryChoices,
  categoryName,
  copiedRates,
  copyForm,
  durationText,
  movedCategoryOrder,
  movedOrder,
  newService,
  newServiceForm,
  priceInput,
  priceList,
  serviceChange,
  serviceCopy,
  staffChange,
  staffChoices,
  toggled,
  type CopyForm,
  type NewServiceForm,
  type Service,
  type ServiceGroup,
} from '../services';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 93: "Usługi" — the owner or a manager sees the price list by category and changes a
 * service's price, duration and "bookable online" from the phone; ↑ / ↓ set the order clients
 * see (task 253), and the categories' order too (task 255). "Duplikuj" makes a new service as a
 * copy of one (task 310); a service moves to another category, and a new category is added
 * at the end (task 311); who performs it is ticked in "Zmień" (task 312). "Nowa usługa" adds a
 * service from scratch (task 313); "Zmień" changes the name and the description too (task 314).
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
  const [categories, setCategories] = useState<ServiceCategoryList>([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<{
    name: string;
    description: string;
    price: string;
    duration: string;
    active: boolean;
    categoryId: string | null;
    staffIds: string[];
  }>({
    name: '',
    description: '',
    price: '',
    duration: '',
    active: true,
    categoryId: null,
    staffIds: [],
  });
  /** Task 313: the form of a new service; null = closed. */
  const [fresh, setFresh] = useState<NewServiceForm | null>(null);
  /** Task 312: the salon's specialists (who performs a service). */
  const [staff, setStaff] = useState<StaffList>([]);
  /** Task 311: the name of a new category, as typed. */
  const [newCategory, setNewCategory] = useState('');
  const [busy, setBusy] = useState(false);
  /** Task 310: the service being copied, and the copy's name, price, duration, online. */
  const [copyId, setCopyId] = useState<string | null>(null);
  const [copy, setCopy] = useState<CopyForm>({
    name: '',
    price: '',
    duration: '',
    active: true,
    categoryId: null,
  });

  const load = useCallback(async () => {
    try {
      const [services, categories, staff] = await Promise.all([
        api.services(salon.orgId, salon.locationId),
        api.serviceCategories(salon.orgId, salon.locationId),
        api.staff(salon.orgId, salon.locationId),
      ]);
      setGroups(priceList(services, categories));
      setCategories(categories);
      setStaff(staff);
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
    setCopyId(null);
    setFresh(null);
    setEditId(service.id);
    setForm({
      name: service.name,
      description: service.description ?? '',
      price: priceInput(service.priceGrosze),
      duration: String(service.durationMinutes),
      active: service.active,
      categoryId: service.categoryId,
      staffIds: [...service.staffIds],
    });
    setError('');
    setInfo('');
  }

  async function save(service: Service) {
    const checked = serviceChange(service, form);
    if (!checked.ok) return setError(u.problem[checked.problem]);
    const people = staffChange(service, form.staffIds);
    if (!checked.change && !people) {
      setEditId(null);
      return setInfo(u.nothing);
    }
    setBusy(true);
    try {
      if (checked.change) {
        await api.updateService(salon.orgId, salon.locationId, service.id, checked.change);
      }
      // Task 312: who performs it — a list of its own, saved after the rest.
      if (people) await api.setServiceStaff(salon.orgId, salon.locationId, service.id, people);
      setEditId(null);
      setInfo(fill(u.saved, { name: checked.change?.name ?? service.name }));
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

  /** Task 310: "Duplikuj" — the copy's form, filled as the service. Nothing is created yet. */
  function duplicate(service: Service) {
    setEditId(null);
    setFresh(null);
    setCopyId(service.id);
    setCopy(copyForm(service, u.copyName));
    setError('');
    setInfo('');
  }

  /**
   * Task 310: creates the copy (as the cabinet's "Duplikuj", task 251) with the specialists'
   * own prices and durations of the source; it lands at the end of its category.
   */
  async function saveCopy(source: Service) {
    const checked = serviceCopy(source, copy);
    if (!checked.ok) return setError(u.problem[checked.problem]);
    setBusy(true);
    try {
      const rates = await api.staffPrices(salon.orgId, salon.locationId);
      const created = await api.createService(salon.orgId, salon.locationId, checked.service);
      const own = copiedRates(rates, source.id, created.staffIds);
      if (own.prices.length > 0) {
        await api.saveStaffPrices(salon.orgId, salon.locationId, created.id, own.prices);
      }
      if (own.durations.length > 0) {
        await api.saveStaffDurations(salon.orgId, salon.locationId, created.id, own.durations);
      }
      setCopyId(null);
      setInfo(fill(u.copied, { name: created.name }));
      setError('');
      await load();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  /** Task 313: an empty form of a new service at the end of the screen. */
  function startNew() {
    setEditId(null);
    setCopyId(null);
    setFresh(newServiceForm(categories, staff));
    setError('');
    setInfo('');
  }

  /** Task 313: creates the service; it lands at the end of its category. */
  async function saveNew() {
    if (!fresh) return;
    const checked = newService(fresh);
    if (!checked.ok) return setError(u.problem[checked.problem]);
    setBusy(true);
    try {
      const created = await api.createService(salon.orgId, salon.locationId, checked.service);
      setFresh(null);
      setInfo(fill(u.copied, { name: created.name }));
      setError('');
      await load();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  /** Task 312: ticks of who performs a service (also of a new one, task 313). */
  function performersPicker(staffIds: string[], onChange: (staffIds: string[]) => void) {
    return (
      <>
        <Text style={styles.label}>{u.performers}</Text>
        {staffChoices(staff, staffIds).map((member) => {
          const on = staffIds.includes(member.id);
          return (
            <Pressable
              key={member.id}
              accessibilityRole="checkbox"
              accessibilityLabel={member.displayName}
              accessibilityState={{ checked: on }}
              aria-checked={on}
              onPress={() => onChange(toggled(staffIds, member.id))}
              style={styles.check}
            >
              <Text style={[styles.box, on && styles.boxOn]}>{on ? '✓' : ''}</Text>
              <Text style={[styles.text, { flexShrink: 1 }]}>
                {member.active ? member.displayName : `${member.displayName} · ${u.inactive}`}
              </Text>
            </Pressable>
          );
        })}
        {staffIds.length === 0 ? <Text style={styles.warn}>{u.nobody}</Text> : null}
      </>
    );
  }

  /** Task 314: the name and the description of a service (also of a new one, task 313). */
  function nameFields(
    value: { name: string; description: string },
    onChange: (change: { name?: string; description?: string }) => void,
  ) {
    return (
      <>
        <Text style={styles.label}>{u.name}</Text>
        <TextInput
          accessibilityLabel={u.name}
          value={value.name}
          onChangeText={(name) => onChange({ name })}
          maxLength={100}
          style={styles.input}
        />
        <Text style={styles.label}>{u.description}</Text>
        <TextInput
          accessibilityLabel={u.description}
          value={value.description}
          onChangeText={(description) => onChange({ description })}
          maxLength={500}
          multiline
          placeholder={u.descriptionPlaceholder}
          style={[styles.input, { minHeight: 72, textAlignVertical: 'top' }]}
        />
      </>
    );
  }

  /** Task 311: a new category at the end of the order; the owner then puts services in it. */
  async function addCategory() {
    const name = categoryName(newCategory);
    if (!name) return setError(u.problem.category);
    setBusy(true);
    try {
      await api.createServiceCategory(salon.orgId, salon.locationId, name);
      setNewCategory('');
      setInfo(fill(u.categoryAdded, { name }));
      setError('');
      await load();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  /** Task 311: the category of a service (or of its copy) — radio chips, "Bez kategorii" last. */
  function categoryPicker(value: string | null, onChange: (id: string | null) => void) {
    const options = [
      ...categoryChoices(categories).map((c) => ({ id: c.id as string | null, name: c.name })),
      { id: null, name: u.other },
    ];
    return (
      <>
        <Text style={styles.label}>{u.category}</Text>
        <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={u.category}>
          {options.map((option) => {
            const on = option.id === value;
            return (
              <Pressable
                key={option.id ?? '-'}
                accessibilityRole="radio"
                accessibilityLabel={option.name}
                accessibilityState={{ checked: on }}
                aria-checked={on}
                onPress={() => onChange(option.id)}
                style={[styles.chip, on && styles.chipOn]}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{option.name}</Text>
              </Pressable>
            );
          })}
        </View>
      </>
    );
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
      setCategories(categories);
      setInfo(u.orderSaved);
      setError('');
    } catch (e) {
      setError(errorText(e, t));
      await load();
    } finally {
      setBusy(false);
    }
  }

  /** Task 255: a category one place up or down — clients see the price-list groups so. */
  async function moveCategory(id: string, step: -1 | 1) {
    const order = groups ? movedCategoryOrder(categories, groups, id, step) : null;
    if (!order || busy) return;
    setBusy(true);
    try {
      const [sorted, services] = await Promise.all([
        api.reorderServiceCategories(salon.orgId, salon.locationId, order),
        api.services(salon.orgId, salon.locationId),
      ]);
      setGroups(priceList(services, sorted));
      setCategories(sorted);
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
        groups.map((group, groupIndex) => {
          const id = group.id;
          const named = groups.filter((g) => g.id).length;
          return (
            <View key={id ?? '-'} style={{ gap: 10 }}>
              <View style={styles.row}>
                <Text role="heading" aria-level={2} style={[styles.section, { flexShrink: 1 }]}>
                  {group.name ?? u.other}
                </Text>
                {id && groupIndex > 0 ? (
                  <Button
                    kind="link"
                    label="↑"
                    a11yLabel={fill(u.categoryUp, { name: group.name ?? '' })}
                    onPress={() => void moveCategory(id, -1)}
                  />
                ) : null}
                {id && groupIndex < named - 1 ? (
                  <Button
                    kind="link"
                    label="↓"
                    a11yLabel={fill(u.categoryDown, { name: group.name ?? '' })}
                    onPress={() => void moveCategory(id, 1)}
                  />
                ) : null}
              </View>
              {group.services.map((service, index) => {
                const problem = bookingProblem(service);
                const open = editId === service.id;
                const copying = copyId === service.id;
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
                        {nameFields(form, (change) => setForm((f) => ({ ...f, ...change })))}
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
                        {categoryPicker(form.categoryId, (categoryId) =>
                          setForm((f) => ({ ...f, categoryId })),
                        )}
                        {performersPicker(form.staffIds, (staffIds) =>
                          setForm((f) => ({ ...f, staffIds })),
                        )}
                        <View style={styles.row}>
                          <Button label={u.save} busy={busy} onPress={() => void save(service)} />
                          <Button
                            kind="secondary"
                            label={u.cancel}
                            onPress={() => setEditId(null)}
                          />
                        </View>
                      </View>
                    ) : copying ? (
                      <View style={{ gap: 10, marginTop: 6 }}>
                        <Text role="heading" aria-level={3} style={styles.label}>
                          {u.copyTitle}
                        </Text>
                        <Text style={styles.muted}>{u.copyHint}</Text>
                        <Text style={styles.label}>{u.name}</Text>
                        <TextInput
                          accessibilityLabel={u.name}
                          value={copy.name}
                          onChangeText={(name) => setCopy((f) => ({ ...f, name }))}
                          maxLength={100}
                          style={styles.input}
                        />
                        <Text style={styles.label}>
                          {fill(u.price, { currency: salon.currency })}
                        </Text>
                        <TextInput
                          accessibilityLabel={fill(u.price, { currency: salon.currency })}
                          value={copy.price}
                          onChangeText={(price) => setCopy((f) => ({ ...f, price }))}
                          keyboardType="decimal-pad"
                          style={styles.input}
                        />
                        <Text style={styles.label}>{u.duration}</Text>
                        <TextInput
                          accessibilityLabel={u.duration}
                          value={copy.duration}
                          onChangeText={(duration) => setCopy((f) => ({ ...f, duration }))}
                          keyboardType="number-pad"
                          style={styles.input}
                        />
                        <Pressable
                          accessibilityRole="checkbox"
                          accessibilityLabel={u.active}
                          accessibilityState={{ checked: copy.active }}
                          onPress={() => setCopy((f) => ({ ...f, active: !f.active }))}
                          style={styles.check}
                        >
                          <Text style={[styles.box, copy.active && styles.boxOn]}>
                            {copy.active ? '✓' : ''}
                          </Text>
                          <Text style={[styles.text, { flexShrink: 1 }]}>{u.active}</Text>
                        </Pressable>
                        {categoryPicker(copy.categoryId, (categoryId) =>
                          setCopy((f) => ({ ...f, categoryId })),
                        )}
                        <View style={styles.row}>
                          <Button
                            label={u.save}
                            busy={busy}
                            onPress={() => void saveCopy(service)}
                          />
                          <Button
                            kind="secondary"
                            label={u.cancel}
                            onPress={() => setCopyId(null)}
                          />
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
                        <Button
                          kind="link"
                          label={u.duplicate}
                          a11yLabel={`${u.duplicate}: ${service.name}`}
                          onPress={() => duplicate(service)}
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
          );
        })
      )}
      {groups !== null ? (
        <View style={{ gap: 10 }}>
          <Text role="heading" aria-level={2} style={styles.section}>
            {u.newService}
          </Text>
          {fresh ? (
            <Card>
              <View style={{ gap: 10 }}>
                {nameFields(fresh, (change) => setFresh((f) => (f ? { ...f, ...change } : f)))}
                <Text style={styles.label}>{fill(u.price, { currency: salon.currency })}</Text>
                <TextInput
                  accessibilityLabel={fill(u.price, { currency: salon.currency })}
                  value={fresh.price}
                  onChangeText={(price) => setFresh((f) => (f ? { ...f, price } : f))}
                  keyboardType="decimal-pad"
                  placeholder="90"
                  style={styles.input}
                />
                <Text style={styles.label}>{u.duration}</Text>
                <TextInput
                  accessibilityLabel={u.duration}
                  value={fresh.duration}
                  onChangeText={(duration) => setFresh((f) => (f ? { ...f, duration } : f))}
                  keyboardType="number-pad"
                  style={styles.input}
                />
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityLabel={u.active}
                  accessibilityState={{ checked: fresh.active }}
                  aria-checked={fresh.active}
                  onPress={() => setFresh((f) => (f ? { ...f, active: !f.active } : f))}
                  style={styles.check}
                >
                  <Text style={[styles.box, fresh.active && styles.boxOn]}>
                    {fresh.active ? '✓' : ''}
                  </Text>
                  <Text style={[styles.text, { flexShrink: 1 }]}>{u.active}</Text>
                </Pressable>
                {categoryPicker(fresh.categoryId, (categoryId) =>
                  setFresh((f) => (f ? { ...f, categoryId } : f)),
                )}
                {performersPicker(fresh.staffIds, (staffIds) =>
                  setFresh((f) => (f ? { ...f, staffIds } : f)),
                )}
                <Text style={styles.muted}>{u.newServiceHint}</Text>
                <View style={styles.row}>
                  <Button label={u.save} busy={busy} onPress={() => void saveNew()} />
                  <Button kind="secondary" label={u.cancel} onPress={() => setFresh(null)} />
                </View>
              </View>
            </Card>
          ) : (
            <View style={styles.row}>
              <Button label={u.addService} onPress={startNew} />
            </View>
          )}
          <Text role="heading" aria-level={2} style={styles.section}>
            {u.newCategory}
          </Text>
          <TextInput
            accessibilityLabel={u.newCategory}
            value={newCategory}
            onChangeText={setNewCategory}
            maxLength={60}
            placeholder={u.newCategoryPlaceholder}
            style={styles.input}
          />
          <View style={styles.row}>
            <Button label={u.addCategory} busy={busy} onPress={() => void addCategory()} />
          </View>
        </View>
      ) : null}
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
});
