import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ApiError,
  type BusinessApi,
  type MemberList,
  type PermissionCatalog,
  type StaffCategoryList,
} from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  categoryBody,
  categoryForm,
  changedMeanwhile,
  effective,
  exceptionOf,
  memberUnchanged,
  specialistsWithAccess,
  withException,
  type CategoryForm,
  type Exception,
  type PermissionMap,
  type PermissionKey,
} from '../rights';
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
import { readWhileOpen } from './BookingLinkScreen';
import { SalonReadCache } from './HistoryScreen';
import type { SalonChoice } from './SalonsScreen';

type Category = StaffCategoryList[number];
type Member = MemberList[number];

interface Directory {
  categories: StaffCategoryList;
  people: MemberList;
}

const catalogCache = new SalonReadCache<PermissionCatalog>();
let directoryCache = new SalonReadCache<Directory>();

interface Props {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  onBack: () => void;
}

/**
 * Tasks 330–331: "Uprawnienia" from "Zespół" — like "Dostęp i uprawnienia" in the cabinet.
 * The owner gives each specialist with an account a category of rights and personal exceptions
 * (as in the category / yes / no), and keeps the categories ("Starszy barber"): name, ticks,
 * delete. A manager sees the same and changes nothing (the server allows the owner only).
 */
export function PermissionsScreen(props: Props) {
  const key = JSON.stringify([props.salon.orgId, props.salon.locationId]);
  return <SalonPermissions key={key} {...props} />;
}

function SalonPermissions(props: Props) {
  const { api, t, salon, onBack } = props;
  const r = t.rights;
  const isOwner = salon.role === 'owner';
  const [catalog, setCatalog] = useState<PermissionCatalog['permissions'] | null>(null);
  const [{ categories, people }, setDirectory] = useState<Directory>({
    categories: [],
    people: [],
  });
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  /** The person being changed: their chosen category and exceptions. */
  const [editing, setEditing] = useState<{
    id: string;
    categoryId: string | null;
    overrides: PermissionMap;
  } | null>(null);
  /** The category being written ("new" or its id) and the one waiting for "delete?". */
  const [catForm, setCatForm] = useState<{
    id: string;
    form: CategoryForm;
    nameError?: string;
  } | null>(null);
  const categoryNameInput = useRef<ComponentRef<typeof TextInput>>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const { orgId, locationId } = salon;
  const active = useRef<AbortController | null>(null);
  const [loadFailure, setLoadFailure] = useState<{ cause: unknown } | null>(null);
  const load = useCallback(
    async (signal: AbortSignal, includeCatalog: boolean) => {
      try {
        const [perms, directory] = await Promise.all([
          includeCatalog
            ? readWhileOpen(catalogCache, salon, signal, () => api.permissions(orgId))
            : null,
          readWhileOpen(directoryCache, salon, signal, async () => {
            const [categories, members] = await Promise.all([
              api.staffCategories(orgId),
              api.members(orgId),
            ]);
            return { categories, people: specialistsWithAccess(members, locationId) };
          }),
        ]);
        if (signal.aborted) return;
        if (perms) setCatalog(perms.permissions);
        setDirectory(directory);
        setLoadFailure(null);
      } catch (cause) {
        if (!signal.aborted) setLoadFailure({ cause });
      }
    },
    [api, salon, orgId, locationId],
  );

  useEffect(() => {
    const scope = new AbortController();
    active.current = scope;
    void load(scope.signal, true);
    return () => scope.abort();
  }, [load]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  async function run(
    action: () => Promise<Directory>,
    done: string,
    onFieldError?: (err: unknown) => boolean,
  ): Promise<boolean> {
    const signal = active.current?.signal;
    if (!signal || signal.aborted || pending.current) return false;
    pending.current = true;
    setBusy(true);
    setLoadFailure(null);
    setError('');
    setInfo('');
    try {
      // Rights belong to the organization. Drop other salons' snapshots too. A return
      // to this salon during the save waits for the same authoritative result.
      directoryCache = new SalonReadCache<Directory>();
      const updated = await directoryCache.read(salon, action);
      if (signal.aborted) return false;
      setInfo(done);
      setDirectory(updated);
      return true;
    } catch (e) {
      if (signal.aborted) return false;
      if (changedMeanwhile(e)) {
        setError(r.changedMeanwhile);
        setEditing(null);
        setCatForm(null);
        await load(signal, false);
      } else if (!onFieldError?.(e)) setError(errorText(e, t));
      return false;
    } finally {
      pending.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  async function saveMember(member: Member) {
    if (!editing) return;
    if (memberUnchanged(member, editing.categoryId, editing.overrides)) {
      setEditing(null);
      setInfo(r.nothing);
      return;
    }
    const ok = await run(async () => {
      const saved = await api.setMemberPermissions(salon.orgId, member.membershipId, {
        version: member.version,
        staffCategoryId: editing.categoryId,
        overrides: editing.overrides,
      });
      return {
        people: people.map((person) =>
          person.membershipId === saved.membershipId ? saved : person,
        ),
        categories:
          member.staffCategoryId === saved.staffCategoryId
            ? categories
            : categories.map((category) => {
                if (category.id === member.staffCategoryId)
                  return { ...category, memberCount: category.memberCount - 1 };
                if (category.id === saved.staffCategoryId)
                  return { ...category, memberCount: category.memberCount + 1 };
                return category;
              }),
      };
    }, r.saved);
    if (ok) setEditing(null);
  }

  async function saveCategory() {
    if (!catForm) return;
    const body = categoryBody(catForm.form);
    if (!body.ok) {
      setError('');
      setCatForm({ ...catForm, nameError: r.noName });
      categoryNameInput.current?.focus();
      return;
    }
    const existing = categoriesById.get(catForm.id);
    const ok = await run(
      async () => {
        const saved = existing
          ? await api.updateStaffCategory(salon.orgId, existing.id, existing.version, {
              name: body.name,
              permissions: body.permissions,
            })
          : await api.createStaffCategory(salon.orgId, {
              name: body.name,
              permissions: body.permissions,
            });
        const next = categories.filter((category) => category.id !== saved.id);
        next.push(saved);
        return { people, categories: next.sort((a, b) => a.name.localeCompare(b.name)) };
      },
      r.categorySaved,
      (err) => {
        if (
          !(err instanceof ApiError) ||
          (err.code !== 'CATEGORY_NAME_TAKEN' && !err.details.some(({ path }) => path === 'name'))
        )
          return false;
        setCatForm({ ...catForm, nameError: errorText(err, t) });
        return true;
      },
    );
    if (ok) setCatForm(null);
  }

  const categoriesById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const categoryName = (id: string | null) =>
    (id === null ? undefined : categoriesById.get(id)?.name) ?? r.defaultPerms;
  const label = (key: string) => (r.names as Record<string, string>)[key] ?? key;

  const editMember = useCallback((member: Member) => {
    setInfo('');
    setError('');
    setCatForm(null);
    setEditing({
      id: member.membershipId,
      categoryId: member.staffCategoryId,
      overrides: { ...member.overrides },
    });
  }, []);

  const changeException = useCallback((permission: PermissionKey, value: Exception) => {
    setEditing(
      (current) =>
        current && { ...current, overrides: withException(current.overrides, permission, value) },
    );
  }, []);

  const toggleCategoryPermission = useCallback((key: PermissionKey) => {
    setCatForm((current) => {
      if (!current) return current;
      const { form } = current;
      return {
        ...current,
        form: { ...form, permissions: { ...form.permissions, [key]: !form.permissions[key] } },
      };
    });
  }, []);

  function memberCard(member: Member) {
    const open = editing?.id === member.membershipId ? editing : null;
    if (!open || !catalog) {
      return (
        <MemberSummary
          key={member.membershipId}
          member={member}
          category={categoryName(member.staffCategoryId)}
          r={r}
          onEdit={isOwner ? editMember : undefined}
          disabled={busy}
        />
      );
    }
    const chosen = (open.categoryId && categoriesById.get(open.categoryId)) || null;
    const now = effective(catalog, chosen, open.overrides);
    return (
      <Card key={member.membershipId}>
        <Text style={styles.name}>{member.user.name}</Text>
        <Text style={styles.label}>{r.category}</Text>
        <View style={styles.row}>
          {[null, ...categories.map((c) => c.id)].map((id) => {
            const on = open.categoryId === id;
            return (
              <Pressable
                accessibilityLabel={categoryName(id)}
                key={id ?? 'default'}
                accessibilityRole="button"
                aria-pressed={on}
                disabled={busy}
                accessibilityState={{ selected: on, disabled: busy }}
                onPress={() => setEditing({ ...open, categoryId: id })}
                style={[styles.chip, on && styles.chipOn]}
              >
                <Text style={[styles.chipText, on && { color: '#fff' }]}>{categoryName(id)}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={[styles.label, { marginTop: 12 }]}>{r.exceptions}</Text>
        {catalog.map(({ key }) => (
          <MemberPermission
            key={key}
            permission={key}
            label={label(key)}
            r={r}
            allowed={now[key]}
            value={exceptionOf(open.overrides, key)}
            busy={busy}
            onChange={changeException}
          />
        ))}
        {!memberUnchanged(member, open.categoryId, open.overrides) ? (
          <Text role="status" style={styles.label}>
            {t.navigation.unsaved}
          </Text>
        ) : null}
        {error ? <ErrorText>{error}</ErrorText> : null}
        <View style={styles.row}>
          <Button label={r.save} busy={busy} onPress={() => void saveMember(member)} />
          <Button kind="link" disabled={busy} label={r.cancel} onPress={() => setEditing(null)} />
        </View>
      </Card>
    );
  }

  function categoryEditor() {
    if (!catForm || !catalog) return null;
    const { form } = catForm;
    const saved = categoryForm(categoriesById.get(catForm.id) ?? null, catalog);
    const dirty =
      saved.name !== form.name ||
      catalog.some(({ key }) => saved.permissions[key] !== form.permissions[key]);
    return (
      <Card>
        <Text nativeID="category-name-label" style={styles.label}>
          {r.categoryName}
        </Text>
        <TextInput
          ref={categoryNameInput}
          editable={!busy}
          accessibilityLabel={r.categoryName}
          aria-labelledby="category-name-label"
          accessibilityHint={catForm.nameError}
          aria-invalid={!!catForm.nameError}
          aria-describedby={catForm.nameError ? 'category-name-error' : undefined}
          value={form.name}
          maxLength={60}
          onChangeText={(name) =>
            setCatForm({ ...catForm, nameError: undefined, form: { ...form, name } })
          }
          style={[styles.input, catForm.nameError && styles.invalid]}
        />
        {catForm.nameError ? (
          <Text
            nativeID="category-name-error"
            role="alert"
            accessibilityLiveRegion="assertive"
            style={styles.fieldError}
          >
            ! {catForm.nameError}
          </Text>
        ) : null}
        {catalog.map(({ key }) => (
          <CategoryPermission
            key={key}
            permission={key}
            label={label(key)}
            on={form.permissions[key]}
            busy={busy}
            onChange={toggleCategoryPermission}
          />
        ))}
        {dirty ? (
          <Text role="status" style={styles.label}>
            {t.navigation.unsaved}
          </Text>
        ) : null}
        {error ? <ErrorText>{error}</ErrorText> : null}
        <View style={styles.row}>
          <Button label={r.save} busy={busy} onPress={() => void saveCategory()} />
          <Button kind="link" disabled={busy} label={r.cancel} onPress={() => setCatForm(null)} />
        </View>
      </Card>
    );
  }

  const editCategory = useCallback(
    (category: Category) => {
      if (!catalog) return;
      setInfo('');
      setError('');
      setEditing(null);
      setCatForm({ id: category.id, form: categoryForm(category, catalog) });
    },
    [catalog],
  );

  function removeCategory(category: Category) {
    void run(async () => {
      await api.deleteStaffCategory(salon.orgId, category.id);
      return {
        categories: categories.filter((c) => c.id !== category.id),
        people: people.map((person) =>
          person.staffCategoryId === category.id ? { ...person, staffCategoryId: null } : person,
        ),
      };
    }, r.removed).then((ok) => {
      if (ok) setRemoving(null);
    });
  }

  function categoryCard(category: Category) {
    if (catForm?.id === category.id) return <View key={category.id}>{categoryEditor()}</View>;
    return (
      <CategorySummary
        key={category.id}
        category={category}
        r={r}
        busy={busy}
        onEdit={isOwner && catalog ? editCategory : undefined}
        onRemove={setRemoving}
        confirm={isOwner && removing === category.id ? removeCategory : undefined}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={r.back} onPress={onBack} />
      </View>
      <Heading>{r.title}</Heading>
      <Text style={styles.muted}>{r.hint}</Text>
      {!isOwner ? <Text style={styles.small}>{r.ownerOnly}</Text> : null}
      {info ? (
        <Text role="status" style={styles.info}>
          {info}
        </Text>
      ) : null}
      {error && !catForm && !editing ? <ErrorText>{error}</ErrorText> : null}
      {loadFailure ? (
        <View style={{ gap: 8 }}>
          <ErrorText>{errorText(loadFailure.cause, t)}</ErrorText>
          <Button
            label={t.day.refresh}
            disabled={busy}
            onPress={() => {
              const signal = active.current?.signal;
              if (signal && !signal.aborted) {
                setLoadFailure(null);
                void load(signal, !catalog);
              }
            }}
          />
        </View>
      ) : null}

      {!catalog ? (
        !error && !loadFailure ? (
          <Text style={styles.muted}>{t.loading}</Text>
        ) : null
      ) : (
        <>
          <Text role="heading" aria-level={2} style={styles.section}>
            {r.people}
          </Text>
          {people.length === 0 ? <Text style={styles.muted}>{r.noPeople}</Text> : null}
          {people.map(memberCard)}

          <Text role="heading" aria-level={2} style={styles.section}>
            {r.categories}
          </Text>
          <Text style={styles.small}>{r.categoriesHint}</Text>
          {categories.length === 0 ? <Text style={styles.muted}>{r.noCategories}</Text> : null}
          {categories.map(categoryCard)}
          {catForm?.id === 'new' ? categoryEditor() : null}
          {isOwner && !catForm ? (
            <Button
              kind="secondary"
              disabled={busy}
              label={r.addCategory}
              onPress={() => {
                setInfo('');
                setError('');
                setEditing(null);
                setCatForm({ id: 'new', form: categoryForm(null, catalog) });
              }}
            />
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const CategorySummary = memo(function CategorySummary({
  category,
  r,
  busy,
  onEdit,
  onRemove,
  confirm,
}: {
  category: Category;
  r: Dictionary['rights'];
  busy: boolean;
  onEdit?: (category: Category) => void;
  onRemove: (id: string | null) => void;
  confirm?: (category: Category) => void;
}) {
  return (
    <Card>
      <Text style={styles.name}>{category.name}</Text>
      <Text style={styles.muted}>{fill(r.members, { count: String(category.memberCount) })}</Text>
      {confirm ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.text}>{fill(r.removeAsk, { name: category.name })}</Text>
          <View style={styles.row}>
            <Button label={r.yes} busy={busy} onPress={() => confirm(category)} />
            <Button kind="secondary" disabled={busy} label={r.no} onPress={() => onRemove(null)} />
          </View>
        </View>
      ) : onEdit ? (
        <View style={styles.row}>
          <Button
            kind="secondary"
            disabled={busy}
            label={r.change}
            a11yLabel={`${r.change}: ${category.name}`}
            onPress={() => onEdit(category)}
          />
          <Button
            kind="link"
            disabled={busy}
            label={r.remove}
            a11yLabel={`${r.remove}: ${category.name}`}
            onPress={() => onRemove(category.id)}
          />
        </View>
      ) : null}
    </Card>
  );
});

const MemberPermission = memo(function MemberPermission({
  permission,
  label,
  r,
  allowed,
  value,
  busy,
  onChange,
}: {
  permission: PermissionKey;
  label: string;
  r: Dictionary['rights'];
  allowed: boolean;
  value: Exception;
  busy: boolean;
  onChange: (key: PermissionKey, value: Exception) => void;
}) {
  const options: [Exception, string][] = [
    ['category', r.asCategory],
    ['yes', r.allow],
    ['no', r.deny],
  ];
  return (
    <View style={styles.perm}>
      <Text style={styles.text}>
        {label}
        <Text style={styles.small}> · {allowed ? r.allow : r.deny}</Text>
      </Text>
      <View style={styles.row} accessibilityRole="radiogroup" aria-label={label}>
        {options.map(([key, text]) => {
          const on = value === key;
          return (
            <Pressable
              key={key}
              accessibilityRole="radio"
              accessibilityLabel={`${label}: ${text}`}
              disabled={busy}
              accessibilityState={{ checked: on, disabled: busy }}
              aria-checked={on}
              onPress={() => onChange(permission, key)}
              style={[styles.seg, on && styles.chipOn]}
            >
              <Text style={[styles.segText, on && { color: '#fff' }]}>{text}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
});

const CategoryPermission = memo(function CategoryPermission({
  permission,
  label,
  on,
  busy,
  onChange,
}: {
  permission: PermissionKey;
  label: string;
  on: boolean;
  busy: boolean;
  onChange: (key: PermissionKey) => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      disabled={busy}
      accessibilityState={{ checked: on, disabled: busy }}
      aria-checked={on}
      onPress={() => onChange(permission)}
      style={styles.check}
    >
      <View style={[styles.box, on && styles.boxOn]}>
        {on ? <Text style={styles.tick}>✓</Text> : null}
      </View>
      <Text style={[styles.text, { flexShrink: 1 }]}>{label}</Text>
    </Pressable>
  );
});

const MemberSummary = memo(function MemberSummary({
  member,
  category,
  r,
  onEdit,
  disabled,
}: {
  member: Member;
  category: string;
  r: Dictionary['rights'];
  disabled: boolean;
  onEdit?: (member: Member) => void;
}) {
  const label = (key: string) => (r.names as Record<string, string>)[key] ?? key;
  return (
    <Card>
      <Text style={styles.name}>{member.user.name}</Text>
      <Text style={styles.muted}>{category}</Text>
      {Object.keys(member.overrides).length > 0 ? (
        <Text style={styles.small}>
          {r.exceptions}:{' '}
          {Object.entries(member.overrides)
            .map(([k, v]) => `${label(k)} — ${v ? r.allow : r.deny}`)
            .join('; ')}
        </Text>
      ) : null}
      {onEdit ? (
        <View style={styles.row}>
          <Button
            kind="secondary"
            label={r.change}
            a11yLabel={`${r.change}: ${member.user.name}`}
            disabled={disabled}
            onPress={() => onEdit(member)}
          />
        </View>
      ) : null}
    </Card>
  );
});

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
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    letterSpacing: 1,
    marginBottom: 6,
  },
  name: { fontSize: 16, fontWeight: '600', color: colors.ink },
  text: { fontSize: 15, color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  info: { color: colors.ink, fontSize: 15 },
  perm: { gap: 6, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line },
  invalid: { borderColor: colors.danger },
  fieldError: { color: colors.danger, fontSize: 15 },
  input: {
    minWidth: 0,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    backgroundColor: colors.card,
    color: colors.ink,
    marginBottom: 8,
  },
  chip: {
    maxWidth: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { maxWidth: '100%', textAlign: 'center', fontSize: 15, color: colors.ink },
  seg: {
    maxWidth: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.card,
  },
  segText: { maxWidth: '100%', textAlign: 'center', fontSize: 14, color: colors.ink },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  box: {
    minWidth: 24,
    minHeight: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 6,
  },
  tick: { color: '#fff', fontWeight: '700' },
  boxOn: { backgroundColor: colors.ink },
});
