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
import { useFormDraft } from '../formDrafts';
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
type Editor = { kind: 'member' | 'category'; id: string };
type MemberDraft = {
  categoryId?: string | null;
  exceptions?: Partial<Record<PermissionKey, Exception>>;
};
type CategoryDraft = { name?: string; permissions?: PermissionMap };

function permissionChange<T>(
  changes: Partial<Record<PermissionKey, T>> | undefined,
  key: PermissionKey,
  value: T,
  saved: T,
) {
  const next = { ...changes };
  if (value === saved) delete next[key];
  else next[key] = value;
  return next;
}

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
  const { orgId, locationId } = salon;
  const prefix = `permissions.${orgId}.${locationId}`;
  const [editor, setEditor] = useFormDraft<Editor | null>(`${prefix}.editor`, null);
  const memberId = isOwner && editor?.kind === 'member' ? editor.id : null;
  const categoryId = isOwner && editor?.kind === 'category' ? editor.id : null;
  const [memberDraft, setMemberDraft] = useFormDraft<MemberDraft | null>(
    `${prefix}.member.${memberId}`,
    null,
  );
  const [categoryDraft, setCategoryDraft] = useFormDraft<CategoryDraft | null>(
    `${prefix}.category.${categoryId}`,
    null,
  );
  const [nameError, setNameError] = useState<string>();
  const categoryNameInput = useRef<ComponentRef<typeof TextInput>>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const categoriesById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const member = people.find((person) => person.membershipId === memberId);
  const selectedCategory = memberDraft?.categoryId;
  const editing = member && {
    id: member.membershipId,
    categoryId:
      selectedCategory === null || (selectedCategory && categoriesById.has(selectedCategory))
        ? selectedCategory
        : member.staffCategoryId,
    overrides: (catalog ?? []).reduce((overrides, { key }) => {
      const change = memberDraft?.exceptions?.[key];
      return change ? withException(overrides, key, change) : overrides;
    }, member.overrides),
  };
  const savedCategory = useMemo(() => {
    if (!catalog || !categoryId) return null;
    const existing = categoriesById.get(categoryId);
    return categoryId === 'new' || existing ? categoryForm(existing ?? null, catalog) : null;
  }, [catalog, categoryId, categoriesById]);
  const catForm = savedCategory && {
    name: categoryDraft?.name ?? savedCategory.name,
    permissions: { ...savedCategory.permissions, ...categoryDraft?.permissions },
  };
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
        if (signal.aborted) return false;
        if (perms) setCatalog(perms.permissions);
        setDirectory(directory);
        setLoadFailure(null);
        return true;
      } catch (cause) {
        if (!signal.aborted) setLoadFailure({ cause });
        return false;
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
    onSaved?: () => void,
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
      onSaved?.();
      if (signal.aborted) return false;
      setInfo(done);
      setDirectory(updated);
      return true;
    } catch (e) {
      if (signal.aborted) return false;
      if (changedMeanwhile(e)) {
        setError(r.changedMeanwhile);
        if (await load(signal, false)) closeEditor();
      } else if (!onFieldError?.(e)) setError(errorText(e, t));
      return false;
    } finally {
      pending.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  function closeEditor() {
    if (editor?.kind === 'member') setMemberDraft(null);
    if (editor?.kind === 'category') setCategoryDraft(null);
    setEditor((current) => (current === editor ? null : current));
    setNameError(undefined);
  }

  async function saveMember(member: Member) {
    if (!editing) return;
    if (memberUnchanged(member, editing.categoryId, editing.overrides)) {
      closeEditor();
      setInfo(r.nothing);
      return;
    }
    await run(
      async () => {
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
      },
      r.saved,
      closeEditor,
    );
  }

  async function saveCategory() {
    if (!catForm || !categoryId) return;
    const body = categoryBody(catForm);
    if (!body.ok) {
      setError('');
      setNameError(r.noName);
      categoryNameInput.current?.focus();
      return;
    }
    const existing = categoriesById.get(categoryId);
    await run(
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
      closeEditor,
      (err) => {
        if (
          !(err instanceof ApiError) ||
          (err.code !== 'CATEGORY_NAME_TAKEN' && !err.details.some(({ path }) => path === 'name'))
        )
          return false;
        setNameError(errorText(err, t));
        return true;
      },
    );
  }

  const categoryName = (id: string | null) =>
    (id === null ? undefined : categoriesById.get(id)?.name) ?? r.defaultPerms;
  const label = (key: string) => (r.names as Record<string, string>)[key] ?? key;

  const editMember = useCallback(
    (member: Member) => {
      setInfo('');
      setError('');
      setNameError(undefined);
      setEditor({ kind: 'member', id: member.membershipId });
    },
    [setEditor],
  );

  const changeException = useCallback(
    (permission: PermissionKey, value: Exception) => {
      if (!member) return;
      setMemberDraft((current) => ({
        ...current,
        exceptions: permissionChange(
          current?.exceptions,
          permission,
          value,
          exceptionOf(member.overrides, permission),
        ),
      }));
    },
    [member, setMemberDraft],
  );

  const toggleCategoryPermission = useCallback(
    (key: PermissionKey) => {
      if (!savedCategory) return;
      const saved = savedCategory.permissions[key];
      setCategoryDraft((current) => ({
        ...current,
        permissions: permissionChange(
          current?.permissions,
          key,
          !(current?.permissions?.[key] ?? saved),
          saved,
        ),
      }));
    },
    [savedCategory, setCategoryDraft],
  );

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
                onPress={() =>
                  setMemberDraft((current) => ({
                    ...current,
                    categoryId: id === member.staffCategoryId ? undefined : id,
                  }))
                }
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
          <Button kind="link" disabled={busy} label={r.cancel} onPress={closeEditor} />
        </View>
      </Card>
    );
  }

  function categoryEditor() {
    if (!catForm || !catalog || !savedCategory) return null;
    const dirty =
      savedCategory.name !== catForm.name ||
      catalog.some(({ key }) => savedCategory.permissions[key] !== catForm.permissions[key]);
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
          accessibilityHint={nameError}
          aria-invalid={!!nameError}
          aria-describedby={nameError ? 'category-name-error' : undefined}
          value={catForm.name}
          maxLength={60}
          onChangeText={(name) => {
            setNameError(undefined);
            setCategoryDraft((current) => ({
              ...current,
              name: name === savedCategory.name ? undefined : name,
            }));
          }}
          style={[styles.input, nameError && styles.invalid]}
        />
        {nameError ? (
          <Text
            nativeID="category-name-error"
            role="alert"
            accessibilityLiveRegion="assertive"
            style={styles.fieldError}
          >
            ! {nameError}
          </Text>
        ) : null}
        {catalog.map(({ key }) => (
          <CategoryPermission
            key={key}
            permission={key}
            label={label(key)}
            on={catForm.permissions[key]}
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
          <Button kind="link" disabled={busy} label={r.cancel} onPress={closeEditor} />
        </View>
      </Card>
    );
  }

  const editCategory = useCallback(
    (id: string) => {
      setInfo('');
      setError('');
      setNameError(undefined);
      setEditor({ kind: 'category', id });
    },
    [setEditor],
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
    if (categoryId === category.id) return <View key={category.id}>{categoryEditor()}</View>;
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
          {categoryId === 'new' ? categoryEditor() : null}
          {isOwner && !catForm ? (
            <Button
              kind="secondary"
              disabled={busy}
              label={r.addCategory}
              onPress={() => editCategory('new')}
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
  onEdit?: (id: string) => void;
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
            onPress={() => onEdit(category.id)}
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
