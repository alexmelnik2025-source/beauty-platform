import { FormField } from '../formFields';
import { useFormDraft } from '../formDrafts';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ApiError,
  type BusinessApi,
  type Locale,
  type ServiceCategoryList,
  type StaffList,
  type StaffPrices,
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
  ratesChange,
  ratesForm,
  serviceChange,
  serviceCopy,
  staffChange,
  staffChoices,
  toggled,
  type CopyForm,
  type NewServiceForm,
  type RatesForm,
  type Service,
  type ServiceGroup,
} from '../services';
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 93: "Usługi" — the owner or a manager sees the price list by category and changes a
 * service's price, duration and "bookable online" from the phone; ↑ / ↓ set the order clients
 * see (task 253), and the categories' order too (task 255). "Duplikuj" makes a new service as a
 * copy of one (task 310); a service moves to another category, and a new category is added
 * at the end (task 311); who performs it is ticked in "Zmień" (task 312). "Nowa usługa" adds a
 * service from scratch (task 313); "Zmień" changes the name and the description too (task 314).
 * "Usuń" deletes a service that was never used (task 315); a category is renamed or deleted
 * from its heading (task 316). The break after a service and example photos when booking are set
 * in "Zmień" and in a new service (task 317). A specialist's own price and duration are set under
 * their tick in "Zmień" (task 318).
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
  const [fieldError, setFieldError] = useState<{
    field: string;
    message: string;
    staffId?: string;
  } | null>(null);
  const problemAt = (field: string, staffId?: string) =>
    fieldError?.field === field && fieldError.staffId === staffId ? fieldError.message : undefined;
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [editDraft, setEditDraft, clearEdit] = useFormDraft<{
    id: string;
    fields: Partial<NewServiceForm>;
    rates: Record<string, Partial<RatesForm[string]>>;
  } | null>('services.edit', null);
  const editId = editDraft?.id;
  const [rates, setRates] = useState<StaffPrices>({ prices: [], durations: [] });
  const rateForm = editId ? ratesForm(rates, editId) : {};
  for (const [staffId, overrides] of Object.entries(editDraft?.rates ?? {})) {
    rateForm[staffId] = { price: '', duration: '', ...rateForm[staffId], ...overrides };
  }

  /** Task 315: the service whose "Usuń" waits for a confirmation. */
  const [removeId, setRemoveId] = useState<string | null>(null);
  /** Task 316: the category being renamed (or deleted), with the name as typed. */
  const [categoryEdit, setCategoryEdit, clearCategoryEdit] = useFormDraft<{
    id: string;
    name?: string;
  } | null>('services.categoryEdit', null);
  /** Task 313: the form of a new service; null = closed. */
  const [newDraft, setNewDraft, clearNew] = useFormDraft<{
    fields: Partial<NewServiceForm>;
    more: boolean;
  } | null>('services.fresh', null);
  /** Task 312: the salon's specialists (who performs a service). */
  const [staff, setStaff] = useState<StaffList>([]);
  /** Task 311: the name of a new category, as typed. */
  const [query, setQuery] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [options, setOptions] = useState(false);
  const [rowOptions, setRowOptions] = useState<string | null>(null);
  const [newCategory, setNewCategory, clearNewCategory] = useFormDraft('services.newCategory', '');
  const [busy, setBusy] = useState(false);
  /** Task 310: the service being copied, and the copy's name, price, duration, online. */
  const [copyDraft, setCopyDraft, clearCopy] = useFormDraft<{
    id: string;
    fields: Partial<CopyForm>;
  } | null>('services.copy', null);
  const copyId = copyDraft?.id;
  const fresh =
    newDraft && groups ? { ...newServiceForm(categories, staff), ...newDraft.fields } : null;
  const serviceOptions = newDraft?.more ?? false;

  function setServiceOptions(more: boolean) {
    setNewDraft((draft) => draft && { ...draft, more });
  }

  function changeNew(fields: Partial<NewServiceForm>) {
    setNewDraft((draft) => draft && { ...draft, fields: { ...draft.fields, ...fields } });
  }

  function changeEdit(fields: Partial<NewServiceForm>) {
    setEditDraft((draft) => draft && { ...draft, fields: { ...draft.fields, ...fields } });
  }

  function changeCopy(fields: Partial<CopyForm>) {
    setCopyDraft((draft) => draft && { ...draft, fields: { ...draft.fields, ...fields } });
  }

  const load = useCallback(async () => {
    try {
      const [services, categories, staff, rates] = await Promise.all([
        api.services(salon.orgId, salon.locationId),
        api.serviceCategories(salon.orgId, salon.locationId),
        api.staff(salon.orgId, salon.locationId),
        api.staffPrices(salon.orgId, salon.locationId),
      ]);
      setGroups(priceList(services, categories));
      setCategories(categories);
      setStaff(staff);
      setRates(rates);
      setError('');
      setFieldError(null);
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
    clearCopy();
    clearNew();
    setEditDraft({ id: service.id, fields: {}, rates: {} });
    setError('');
    setFieldError(null);
    setInfo('');
  }

  async function save(service: Service, form: NewServiceForm) {
    const checked = serviceChange(service, form);
    setFieldError(null);
    if (!checked.ok) {
      return setFieldError({ field: checked.problem, message: u.problem[checked.problem] });
    }
    const people = staffChange(service, form.staffIds);
    // Task 318: own prices and durations — checked against the new price and duration.
    const own = ratesChange(
      rates,
      {
        id: service.id,
        priceGrosze: checked.change?.priceGrosze ?? service.priceGrosze,
        durationMinutes: checked.change?.durationMinutes ?? service.durationMinutes,
      },
      rateForm,
      form.staffIds,
    );
    if (!own.ok) {
      const who = staff.find((m) => m.id === own.staffId)?.displayName ?? '';
      return setFieldError({
        field: own.problem,
        staffId: own.staffId,
        message: fill(u.problem[own.problem], { name: who }),
      });
    }
    if (!checked.change && !people && !own.prices && !own.durations) {
      clearEdit();
      return setInfo(u.nothing);
    }
    setBusy(true);
    try {
      if (checked.change) {
        await api.updateService(salon.orgId, salon.locationId, service.id, checked.change);
      }
      // Task 312: who performs it — a list of its own, saved after the rest.
      if (people) await api.setServiceStaff(salon.orgId, salon.locationId, service.id, people);
      // Task 318: only of who performs it, so after the list of who performs it.
      if (own.prices) {
        await api.saveStaffPrices(salon.orgId, salon.locationId, service.id, own.prices);
      }
      if (own.durations) {
        await api.saveStaffDurations(salon.orgId, salon.locationId, service.id, own.durations);
      }
      clearEdit();
      setInfo(fill(u.saved, { name: checked.change?.name ?? service.name }));
      setError('');
      setFieldError(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        clearEdit();
        await load();
        setError(u.conflict);
      } else {
        setError(errorText(e, t));
      }
    } finally {
      setBusy(false);
    }
  }

  /** Task 310: "Duplikuj" — the copy's form, filled as the service. Nothing is created yet. */
  function duplicate(service: Service) {
    clearEdit();
    clearNew();
    setCopyDraft({ id: service.id, fields: {} });
    setError('');
    setFieldError(null);
    setInfo('');
  }

  /**
   * Task 310: creates the copy (as the cabinet's "Duplikuj", task 251) with the specialists'
   * own prices and durations of the source; it lands at the end of its category.
   */
  async function saveCopy(source: Service, copy: CopyForm) {
    const checked = serviceCopy(source, copy);
    setFieldError(null);
    if (!checked.ok)
      return setFieldError({ field: checked.problem, message: u.problem[checked.problem] });
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
      clearCopy();
      setInfo(fill(u.copied, { name: created.name }));
      setError('');
      setFieldError(null);
      await load();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Task 315: deletes a service that was never used. With visits, a reward or a coupon the server
   * keeps it (SERVICE_IN_USE) — the owner hides it from online booking instead.
   */
  async function remove(service: Service) {
    setBusy(true);
    try {
      await api.deleteService(salon.orgId, salon.locationId, service.id);
      setRemoveId(null);
      setInfo(fill(u.removed, { name: service.name }));
      setError('');
      setFieldError(null);
      await load();
    } catch (e) {
      setRemoveId(null);
      setError(
        e instanceof ApiError && e.code === 'SERVICE_IN_USE'
          ? fill(u.inUse, { name: service.name })
          : errorText(e, t),
      );
    } finally {
      setBusy(false);
    }
  }

  /** Task 316: the category's new name (the server checks the version that was read). */
  async function renameCategory() {
    if (!categoryEdit) return;
    const category = categories.find((c) => c.id === categoryEdit.id);
    if (!category) return clearCategoryEdit();
    const name = categoryName(categoryEdit.name ?? category.name);
    setFieldError(null);
    if (!name) return setFieldError({ field: 'category', message: u.problem.category });
    if (name === category.name) {
      clearCategoryEdit();
      return setInfo(u.nothing);
    }
    setBusy(true);
    try {
      await api.renameServiceCategory(
        salon.orgId,
        salon.locationId,
        category.id,
        name,
        category.version,
      );
      clearCategoryEdit();
      setInfo(fill(u.saved, { name }));
      setError('');
      setFieldError(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        clearCategoryEdit();
        await load();
        setError(u.conflict);
      } else {
        setError(errorText(e, t));
      }
    } finally {
      setBusy(false);
    }
  }

  /** Task 316: deletes the category; its services stay, in "Bez kategorii". */
  async function removeCategory(id: string, name: string) {
    setBusy(true);
    try {
      await api.deleteServiceCategory(salon.orgId, salon.locationId, id);
      clearCategoryEdit();
      setInfo(fill(u.categoryRemoved, { name }));
      setError('');
      setFieldError(null);
      await load();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  /** Task 313: an empty form of a new service. */
  function startNew() {
    clearEdit();
    clearCopy();
    setNewDraft({ fields: {}, more: false });
    setError('');
    setFieldError(null);
    setInfo('');
  }

  /** Task 313: creates the service; it lands at the end of its category. */
  async function saveNew() {
    if (!fresh) return;
    const checked = newService(fresh);
    setFieldError(null);
    if (!checked.ok) {
      if (checked.problem === 'buffer') setServiceOptions(true);
      return setFieldError({ field: checked.problem, message: u.problem[checked.problem] });
    }
    setBusy(true);
    try {
      const created = await api.createService(salon.orgId, salon.locationId, checked.service);
      clearNew();
      setInfo(fill(u.copied, { name: created.name }));
      setError('');
      setFieldError(null);
      await load();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  /** Task 312: ticks of who performs a service (also of a new one, task 313). */
  function performersPicker(
    staffIds: string[],
    onChange: (staffIds: string[]) => void,
    /** Task 318: what is shown under a ticked specialist (own price and duration in "Zmień"). */
    under?: (staffId: string, name: string) => ReactNode,
  ) {
    return (
      <>
        <Text style={styles.label}>{u.performers}</Text>
        {staffChoices(staff, staffIds).map((member) => {
          const on = staffIds.includes(member.id);
          return (
            <View key={member.id} style={{ gap: 6 }}>
              <Pressable
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
              {on && under ? under(member.id, member.displayName) : null}
            </View>
          );
        })}
        {staffIds.length === 0 ? <Text style={styles.warn}>{u.nobody}</Text> : null}
      </>
    );
  }

  /**
   * Task 318: a ticked specialist's own price and duration; empty = the service's (shown as the
   * placeholder).
   */
  function ownRates(service: Service, staffId: string, name: string) {
    const row = rateForm[staffId] ?? { price: '', duration: '' };
    const set = (change: { price?: string; duration?: string }) =>
      setEditDraft(
        (draft) =>
          draft && {
            ...draft,
            rates: { ...draft.rates, [staffId]: { ...draft.rates[staffId], ...change } },
          },
      );
    const priceLabel = fill(u.ownPrice, { name, currency: salon.currency });
    const durationLabel = fill(u.ownDuration, { name });
    return (
      <View style={{ gap: 6, paddingLeft: 34 }}>
        <Text style={styles.muted}>{fill(u.ownHint, { name })}</Text>
        <View style={styles.row}>
          <FormField
            error={problemAt('staffPrice', staffId)}
            accessibilityLabel={priceLabel}
            value={row.price}
            onChangeText={(price) => set({ price })}
            keyboardType="decimal-pad"
            placeholder={`${priceInput(service.priceGrosze)} ${salon.currency}`}
            style={[styles.input, styles.small]}
          />
          <FormField
            error={problemAt('staffDuration', staffId)}
            accessibilityLabel={durationLabel}
            value={row.duration}
            onChangeText={(duration) => set({ duration })}
            keyboardType="number-pad"
            placeholder={`${service.durationMinutes} ${u.units.min}`}
            style={[styles.input, styles.small]}
          />
        </View>
      </View>
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
        <FormField
          error={problemAt('name')}
          accessibilityLabel={u.name}
          value={value.name}
          onChangeText={(name) => onChange({ name })}
          maxLength={100}
          style={styles.input}
        />
        <Text style={styles.label}>{u.description}</Text>
        <FormField
          error={problemAt('description')}
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

  /** Task 317: the break after the service and example photos (also of a new one). */
  function extraFields(
    value: { buffer: string; wishPhotos: boolean },
    onChange: (change: { buffer?: string; wishPhotos?: boolean }) => void,
  ) {
    return (
      <>
        <Text style={styles.label}>{u.buffer}</Text>
        <FormField
          error={problemAt('buffer')}
          accessibilityLabel={u.buffer}
          value={value.buffer}
          onChangeText={(buffer) => onChange({ buffer })}
          keyboardType="number-pad"
          style={styles.input}
        />
        <Text style={styles.muted}>{u.bufferHint}</Text>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={u.photosAsk}
          accessibilityState={{ checked: value.wishPhotos }}
          aria-checked={value.wishPhotos}
          onPress={() => onChange({ wishPhotos: !value.wishPhotos })}
          style={styles.check}
        >
          <Text style={[styles.box, value.wishPhotos && styles.boxOn]}>
            {value.wishPhotos ? '✓' : ''}
          </Text>
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.text}>{u.photosAsk}</Text>
            <Text style={styles.muted}>{u.photosAskHint}</Text>
          </View>
        </Pressable>
      </>
    );
  }

  /** Task 311: a new category at the end of the order; the owner then puts services in it. */
  async function addCategory() {
    const name = categoryName(newCategory);
    setFieldError(null);
    if (!name) return setFieldError({ field: 'category', message: u.problem.category });
    setBusy(true);
    try {
      await api.createServiceCategory(salon.orgId, salon.locationId, name);
      clearNewCategory();
      setInfo(fill(u.categoryAdded, { name }));
      setError('');
      setFieldError(null);
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
      setFieldError(null);
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
      setFieldError(null);
    } catch (e) {
      setError(errorText(e, t));
      await load();
    } finally {
      setBusy(false);
    }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = (service: NonNullable<typeof groups>[number]['services'][number]) =>
    service.id === editId ||
    service.id === copyId ||
    service.id === removeId ||
    ((!activeOnly || service.active) && service.name.toLocaleLowerCase().includes(normalizedQuery));
  const filtering = activeOnly || normalizedQuery !== '';

  const price = (hundredths: number) => formatPrice(hundredths, salon.currency, props.locale);

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={u.back} onPress={onBack} />
      </View>
      <Heading>{u.title}</Heading>
      {groups && !fresh ? <Button label={u.addService} onPress={startNew} /> : null}
      {info ? (
        <Text role="status" style={styles.info}>
          {info}
        </Text>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}

      {fresh ? (
        <Card>
          <View style={{ gap: 10 }}>
            {nameFields(fresh, changeNew)}
            <Text style={styles.label}>{fill(u.price, { currency: salon.currency })}</Text>
            <FormField
              error={problemAt('price')}
              accessibilityLabel={fill(u.price, { currency: salon.currency })}
              value={fresh.price}
              onChangeText={(price) => changeNew({ price })}
              keyboardType="decimal-pad"
              placeholder="90"
              style={styles.input}
            />
            <Text style={styles.label}>{u.duration}</Text>
            <FormField
              error={problemAt('duration')}
              accessibilityLabel={u.duration}
              value={fresh.duration}
              onChangeText={(duration) => changeNew({ duration })}
              keyboardType="number-pad"
              style={styles.input}
            />
            <Button
              kind="link"
              label={`${t.navigation.more} ${serviceOptions ? '▾' : '▸'}`}
              expanded={serviceOptions}
              onPress={() => setServiceOptions(!serviceOptions)}
            />
            {serviceOptions ? (
              <>
                {extraFields(fresh, changeNew)}
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityLabel={u.active}
                  accessibilityState={{ checked: fresh.active }}
                  aria-checked={fresh.active}
                  onPress={() => changeNew({ active: !fresh.active })}
                  style={styles.check}
                >
                  <Text style={[styles.box, fresh.active && styles.boxOn]}>
                    {fresh.active ? '✓' : ''}
                  </Text>
                  <Text style={[styles.text, { flexShrink: 1 }]}>{u.active}</Text>
                </Pressable>
                {categoryPicker(fresh.categoryId, (categoryId) => changeNew({ categoryId }))}
                {performersPicker(fresh.staffIds, (staffIds) => changeNew({ staffIds }))}
                <Text style={styles.muted}>{u.newServiceHint}</Text>
              </>
            ) : null}
            <View style={styles.row}>
              <Button label={u.save} busy={busy} onPress={() => void saveNew()} />
              <Button kind="secondary" label={u.cancel} onPress={clearNew} />
            </View>
          </View>
        </Card>
      ) : null}
      {groups && groups.length > 0 ? (
        <>
          <TextInput
            accessibilityLabel={t.navigation.searchServices}
            placeholder={t.navigation.searchServices}
            placeholderTextColor={colors.placeholder}
            value={query}
            onChangeText={setQuery}
            style={styles.input}
          />
          <View style={styles.row}>
            <Button
              kind="secondary"
              label={t.navigation.all}
              compact
              selected={!activeOnly}
              onPress={() => setActiveOnly(false)}
            />
            <Button
              kind="secondary"
              label={t.navigation.active}
              compact
              selected={activeOnly}
              onPress={() => setActiveOnly(true)}
            />
          </View>
        </>
      ) : null}

      {groups ? (
        <Button
          kind="link"
          label={`${t.navigation.serviceCategories} ${options ? '▾' : '▸'}`}
          expanded={options}
          onPress={() => setOptions(!options)}
        />
      ) : null}
      {groups === null ? (
        !error ? (
          <Text style={styles.muted}>{t.loading}</Text>
        ) : null
      ) : groups.length === 0 ? (
        <Text style={styles.muted}>{u.none}</Text>
      ) : filtering && !groups.some((group) => group.services.some(visible)) ? (
        <Text style={styles.muted} role="status">
          {t.navigation.noServices}
        </Text>
      ) : (
        groups.map((group, groupIndex) => {
          if (filtering && !group.services.some(visible)) return null;
          const id = group.id;
          const named = groups.filter((g) => g.id).length;
          return (
            <View key={id ?? '-'} style={{ gap: 10 }}>
              <View style={styles.row}>
                <Text role="heading" aria-level={2} style={[styles.section, { flexShrink: 1 }]}>
                  {group.name ?? u.other}
                </Text>
                {options && id && groupIndex > 0 ? (
                  <Button
                    kind="link"
                    label="↑"
                    a11yLabel={fill(u.categoryUp, { name: group.name ?? '' })}
                    onPress={() => void moveCategory(id, -1)}
                  />
                ) : null}
                {options && id && groupIndex < named - 1 ? (
                  <Button
                    kind="link"
                    label="↓"
                    a11yLabel={fill(u.categoryDown, { name: group.name ?? '' })}
                    onPress={() => void moveCategory(id, 1)}
                  />
                ) : null}
                {options && id && categoryEdit?.id !== id ? (
                  <Button
                    kind="link"
                    label={u.edit}
                    a11yLabel={fill(u.categoryEdit, { name: group.name ?? '' })}
                    onPress={() => {
                      setCategoryEdit({ id });
                      setError('');
                      setFieldError(null);
                      setInfo('');
                    }}
                  />
                ) : null}
              </View>
              {id && categoryEdit?.id === id ? (
                <Card>
                  <View style={{ gap: 10 }}>
                    <Text style={styles.label}>{u.categoryNameLabel}</Text>
                    <FormField
                      error={problemAt('category')}
                      accessibilityLabel={u.categoryNameLabel}
                      value={categoryEdit.name ?? group.name ?? ''}
                      onChangeText={(name) => setCategoryEdit({ id, name })}
                      maxLength={60}
                      style={styles.input}
                    />
                    <View style={styles.row}>
                      <Button label={u.save} busy={busy} onPress={() => void renameCategory()} />
                      <Button kind="secondary" label={u.cancel} onPress={clearCategoryEdit} />
                    </View>
                    <Text style={styles.muted}>
                      {fill(u.categoryRemoveHint, { count: String(group.services.length) })}
                    </Text>
                    <View style={styles.row}>
                      <Button
                        kind="secondary"
                        label={u.categoryRemove}
                        busy={busy}
                        onPress={() => void removeCategory(id, group.name ?? '')}
                      />
                    </View>
                  </View>
                </Card>
              ) : null}
              {group.services.map((service, index) => {
                if (!visible(service)) return null;
                const problem = bookingProblem(service);
                const form =
                  editDraft?.id === service.id
                    ? {
                        name: service.name,
                        description: service.description ?? '',
                        buffer: String(service.bufferMinutes),
                        wishPhotos: service.wishPhotos,
                        price: priceInput(service.priceGrosze),
                        duration: String(service.durationMinutes),
                        active: service.active,
                        categoryId: service.categoryId,
                        staffIds: service.staffIds,
                        ...editDraft.fields,
                      }
                    : null;
                const copy =
                  copyDraft?.id === service.id
                    ? { ...copyForm(service, u.copyName), ...copyDraft.fields }
                    : null;
                return (
                  <Card key={service.id}>
                    <Pressable
                      accessibilityLabel={service.name}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: rowOptions === service.id }}
                      aria-expanded={rowOptions === service.id}
                      onPress={() => setRowOptions(rowOptions === service.id ? null : service.id)}
                      style={styles.serviceRow}
                    >
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[styles.name, !service.active && { color: colors.muted }]}>
                          {service.name}
                        </Text>
                        <Text style={styles.muted}>
                          {service.active ? t.navigation.active : u.hidden}
                        </Text>
                      </View>
                      <Text style={styles.text}>
                        {durationText(service.durationMinutes, u.units)}
                      </Text>
                      <Text style={styles.name}>{price(service.priceGrosze)}</Text>
                      <Text aria-hidden style={styles.muted}>
                        {rowOptions === service.id ? '▾' : '›'}
                      </Text>
                    </Pressable>
                    {problem ? (
                      <Text style={styles.warn}>{problem === 'hidden' ? u.hidden : u.nobody}</Text>
                    ) : null}
                    {form ? (
                      <View style={{ gap: 10, marginTop: 6 }}>
                        {nameFields(form, changeEdit)}
                        <Text style={styles.label}>
                          {fill(u.price, { currency: salon.currency })}
                        </Text>
                        <FormField
                          error={problemAt('price')}
                          accessibilityLabel={fill(u.price, { currency: salon.currency })}
                          value={form.price}
                          onChangeText={(price) => changeEdit({ price })}
                          keyboardType="decimal-pad"
                          style={styles.input}
                        />
                        <Text style={styles.label}>{u.duration}</Text>
                        <FormField
                          error={problemAt('duration')}
                          accessibilityLabel={u.duration}
                          value={form.duration}
                          onChangeText={(duration) => changeEdit({ duration })}
                          keyboardType="number-pad"
                          style={styles.input}
                        />
                        {extraFields(form, changeEdit)}
                        <Pressable
                          accessibilityRole="checkbox"
                          accessibilityLabel={u.active}
                          accessibilityState={{ checked: form.active }}
                          onPress={() => changeEdit({ active: !form.active })}
                          style={styles.check}
                        >
                          <Text style={[styles.box, form.active && styles.boxOn]}>
                            {form.active ? '✓' : ''}
                          </Text>
                          <Text style={[styles.text, { flexShrink: 1 }]}>{u.active}</Text>
                        </Pressable>
                        {categoryPicker(form.categoryId, (categoryId) =>
                          changeEdit({ categoryId }),
                        )}
                        {performersPicker(
                          form.staffIds,
                          (staffIds) => changeEdit({ staffIds }),
                          (staffId, name) => ownRates(service, staffId, name),
                        )}
                        <View style={styles.row}>
                          <Button
                            label={u.save}
                            busy={busy}
                            onPress={() => void save(service, form)}
                          />
                          <Button kind="secondary" label={u.cancel} onPress={clearEdit} />
                        </View>
                      </View>
                    ) : copy ? (
                      <View style={{ gap: 10, marginTop: 6 }}>
                        <Text role="heading" aria-level={3} style={styles.label}>
                          {u.copyTitle}
                        </Text>
                        <Text style={styles.muted}>{u.copyHint}</Text>
                        <Text style={styles.label}>{u.name}</Text>
                        <FormField
                          error={problemAt('name')}
                          accessibilityLabel={u.name}
                          value={copy.name}
                          onChangeText={(name) => changeCopy({ name })}
                          maxLength={100}
                          style={styles.input}
                        />
                        <Text style={styles.label}>
                          {fill(u.price, { currency: salon.currency })}
                        </Text>
                        <FormField
                          error={problemAt('price')}
                          accessibilityLabel={fill(u.price, { currency: salon.currency })}
                          value={copy.price}
                          onChangeText={(price) => changeCopy({ price })}
                          keyboardType="decimal-pad"
                          style={styles.input}
                        />
                        <Text style={styles.label}>{u.duration}</Text>
                        <FormField
                          error={problemAt('duration')}
                          accessibilityLabel={u.duration}
                          value={copy.duration}
                          onChangeText={(duration) => changeCopy({ duration })}
                          keyboardType="number-pad"
                          style={styles.input}
                        />
                        <Pressable
                          accessibilityRole="checkbox"
                          accessibilityLabel={u.active}
                          accessibilityState={{ checked: copy.active }}
                          onPress={() => changeCopy({ active: !copy.active })}
                          style={styles.check}
                        >
                          <Text style={[styles.box, copy.active && styles.boxOn]}>
                            {copy.active ? '✓' : ''}
                          </Text>
                          <Text style={[styles.text, { flexShrink: 1 }]}>{u.active}</Text>
                        </Pressable>
                        {categoryPicker(copy.categoryId, (categoryId) =>
                          changeCopy({ categoryId }),
                        )}
                        <View style={styles.row}>
                          <Button
                            label={u.save}
                            busy={busy}
                            onPress={() => void saveCopy(service, copy)}
                          />
                          <Button kind="secondary" label={u.cancel} onPress={clearCopy} />
                        </View>
                      </View>
                    ) : removeId === service.id ? (
                      <View style={{ gap: 10, marginTop: 6 }}>
                        <Text style={styles.text}>{fill(u.removeAsk, { name: service.name })}</Text>
                        <View style={styles.row}>
                          <Button
                            label={u.remove}
                            a11yLabel={fill(u.removeConfirm, { name: service.name })}
                            busy={busy}
                            onPress={() => void remove(service)}
                          />
                          <Button
                            kind="secondary"
                            label={u.cancel}
                            onPress={() => setRemoveId(null)}
                          />
                        </View>
                      </View>
                    ) : rowOptions === service.id ? (
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
                        <Button
                          kind="link"
                          label={u.remove}
                          a11yLabel={`${u.remove}: ${service.name}`}
                          onPress={() => {
                            clearEdit();
                            clearCopy();
                            setRemoveId(service.id);
                            setError('');
                            setFieldError(null);
                            setInfo('');
                          }}
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
                    ) : null}
                  </Card>
                );
              })}
            </View>
          );
        })
      )}
      {groups !== null ? (
        <View style={{ gap: 10 }}>
          {options ? (
            <>
              <Text role="heading" aria-level={2} style={styles.section}>
                {u.newCategory}
              </Text>
              <FormField
                error={!categoryEdit ? problemAt('category') : undefined}
                accessibilityLabel={u.newCategory}
                value={newCategory}
                onChangeText={setNewCategory}
                maxLength={60}
                placeholder={u.newCategoryPlaceholder}
                style={styles.input}
              />
              <View style={styles.row}>
                <Button
                  kind="secondary"
                  label={u.addCategory}
                  busy={busy}
                  onPress={() => void addCategory()}
                />
              </View>
            </>
          ) : null}
        </View>
      ) : null}
      {groups && groups.length > 0 ? <Text style={styles.muted}>{u.hint}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  serviceRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
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
  small: { minWidth: 110, flexGrow: 1, flexBasis: 110, paddingVertical: 8 },
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
