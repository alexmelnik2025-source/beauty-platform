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
import type { BusinessApi, MemberList, PermissionCatalog, StaffCategoryList } from '../api';
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
} from '../rights';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

type Category = StaffCategoryList[number];
type Member = MemberList[number];

/**
 * Tasks 330–331: "Uprawnienia" from "Zespół" — like "Dostęp i uprawnienia" in the cabinet.
 * The owner gives each specialist with an account a category of rights and personal exceptions
 * (as in the category / yes / no), and keeps the categories ("Starszy barber"): name, ticks,
 * delete. A manager sees the same and changes nothing (the server allows the owner only).
 */
export function PermissionsScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const r = t.rights;
  const isOwner = salon.role === 'owner';
  const [catalog, setCatalog] = useState<PermissionCatalog['permissions'] | null>(null);
  const [categories, setCategories] = useState<StaffCategoryList>([]);
  const [people, setPeople] = useState<MemberList>([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  /** The person being changed: their chosen category and exceptions. */
  const [editing, setEditing] = useState<{
    id: string;
    categoryId: string | null;
    overrides: PermissionMap;
  } | null>(null);
  /** The category being written ("new" or its id) and the one waiting for "delete?". */
  const [catForm, setCatForm] = useState<{ id: string | 'new'; form: CategoryForm } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [perms, cats, members] = await Promise.all([
        api.permissions(salon.orgId),
        api.staffCategories(salon.orgId),
        api.members(salon.orgId),
      ]);
      setCatalog(perms.permissions);
      setCategories(cats);
      setPeople(specialistsWithAccess(members, salon.locationId));
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

  async function run(action: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await action();
      setInfo(done);
      await load();
      return true;
    } catch (e) {
      if (changedMeanwhile(e)) {
        setError(r.changedMeanwhile);
        setEditing(null);
        setCatForm(null);
        await load();
      } else setError(errorText(e, t));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveMember(member: Member) {
    if (!editing) return;
    if (memberUnchanged(member, editing.categoryId, editing.overrides)) {
      setEditing(null);
      setInfo(r.nothing);
      return;
    }
    const ok = await run(
      () =>
        api.setMemberPermissions(salon.orgId, member.membershipId, {
          version: member.version,
          staffCategoryId: editing.categoryId,
          overrides: editing.overrides,
        }),
      r.saved,
    );
    if (ok) setEditing(null);
  }

  async function saveCategory() {
    if (!catForm) return;
    const body = categoryBody(catForm.form);
    if (!body.ok) {
      setError(r.noName);
      return;
    }
    const existing = categories.find((c) => c.id === catForm.id);
    const ok = await run(
      () =>
        existing
          ? api.updateStaffCategory(salon.orgId, existing.id, existing.version, {
              name: body.name,
              permissions: body.permissions,
            })
          : api.createStaffCategory(salon.orgId, {
              name: body.name,
              permissions: body.permissions,
            }),
      r.categorySaved,
    );
    if (ok) setCatForm(null);
  }

  const categoryName = (id: string | null) =>
    categories.find((c) => c.id === id)?.name ?? r.defaultPerms;
  const label = (key: string) => (r.names as Record<string, string>)[key] ?? key;

  function memberCard(member: Member) {
    const open = editing?.id === member.membershipId ? editing : null;
    if (!open || !catalog) {
      return (
        <Card key={member.membershipId}>
          <Text style={styles.name}>{member.user.name}</Text>
          <Text style={styles.muted}>{categoryName(member.staffCategoryId)}</Text>
          {Object.keys(member.overrides).length > 0 ? (
            <Text style={styles.small}>
              {r.exceptions}:{' '}
              {Object.entries(member.overrides)
                .map(([k, v]) => `${label(k)} — ${v ? r.allow : r.deny}`)
                .join('; ')}
            </Text>
          ) : null}
          {isOwner ? (
            <View style={styles.row}>
              <Button
                kind="secondary"
                label={r.change}
                a11yLabel={`${r.change}: ${member.user.name}`}
                onPress={() => {
                  setInfo('');
                  setError('');
                  setCatForm(null);
                  setEditing({
                    id: member.membershipId,
                    categoryId: member.staffCategoryId,
                    overrides: { ...member.overrides },
                  });
                }}
              />
            </View>
          ) : null}
        </Card>
      );
    }
    const chosen = categories.find((c) => c.id === open.categoryId) ?? null;
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
                key={id ?? 'default'}
                accessibilityRole="button"
                aria-pressed={on}
                accessibilityState={{ selected: on }}
                onPress={() => setEditing({ ...open, categoryId: id })}
                style={[styles.chip, on && styles.chipOn]}
              >
                <Text style={[styles.chipText, on && { color: '#fff' }]}>{categoryName(id)}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={[styles.label, { marginTop: 12 }]}>{r.exceptions}</Text>
        {catalog.map((p) => {
          const value = exceptionOf(open.overrides, p.key);
          const options: [Exception, string][] = [
            ['category', r.asCategory],
            ['yes', r.allow],
            ['no', r.deny],
          ];
          return (
            <View key={p.key} style={styles.perm}>
              <Text style={styles.text}>
                {label(p.key)}
                <Text style={styles.small}> · {now[p.key] ? r.allow : r.deny}</Text>
              </Text>
              <View style={styles.row} accessibilityRole="radiogroup" aria-label={label(p.key)}>
                {options.map(([key, text]) => {
                  const on = value === key;
                  return (
                    <Pressable
                      key={key}
                      accessibilityRole="radio"
                      accessibilityLabel={`${label(p.key)}: ${text}`}
                      accessibilityState={{ checked: on }}
                      aria-checked={on}
                      onPress={() =>
                        setEditing({
                          ...open,
                          overrides: withException(open.overrides, p.key, key),
                        })
                      }
                      style={[styles.seg, on && styles.chipOn]}
                    >
                      <Text style={[styles.segText, on && { color: '#fff' }]}>{text}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })}
        <View style={styles.row}>
          <Button label={r.save} busy={busy} onPress={() => void saveMember(member)} />
          <Button kind="link" label={r.cancel} onPress={() => setEditing(null)} />
        </View>
      </Card>
    );
  }

  function categoryEditor() {
    if (!catForm || !catalog) return null;
    const { form } = catForm;
    return (
      <Card>
        <Text style={styles.label}>{r.categoryName}</Text>
        <TextInput
          accessibilityLabel={r.categoryName}
          value={form.name}
          maxLength={60}
          onChangeText={(name) => setCatForm({ ...catForm, form: { ...form, name } })}
          style={styles.input}
        />
        {catalog.map((p) => {
          const on = form.permissions[p.key];
          return (
            <Pressable
              key={p.key}
              accessibilityRole="checkbox"
              accessibilityLabel={label(p.key)}
              accessibilityState={{ checked: on }}
              aria-checked={on}
              onPress={() =>
                setCatForm({
                  ...catForm,
                  form: { ...form, permissions: { ...form.permissions, [p.key]: !on } },
                })
              }
              style={styles.check}
            >
              <Text style={[styles.box, on && styles.boxOn]}>{on ? '✓' : ''}</Text>
              <Text style={[styles.text, { flexShrink: 1 }]}>{label(p.key)}</Text>
            </Pressable>
          );
        })}
        <View style={styles.row}>
          <Button label={r.save} busy={busy} onPress={() => void saveCategory()} />
          <Button kind="link" label={r.cancel} onPress={() => setCatForm(null)} />
        </View>
      </Card>
    );
  }

  function categoryCard(category: Category) {
    if (catForm?.id === category.id) return <View key={category.id}>{categoryEditor()}</View>;
    return (
      <Card key={category.id}>
        <Text style={styles.name}>{category.name}</Text>
        <Text style={styles.muted}>{fill(r.members, { count: String(category.memberCount) })}</Text>
        {isOwner && removing === category.id ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.text}>{fill(r.removeAsk, { name: category.name })}</Text>
            <View style={styles.row}>
              <Button
                label={r.yes}
                busy={busy}
                onPress={() =>
                  void run(() => api.deleteStaffCategory(salon.orgId, category.id), r.removed).then(
                    () => setRemoving(null),
                  )
                }
              />
              <Button kind="secondary" label={r.no} onPress={() => setRemoving(null)} />
            </View>
          </View>
        ) : isOwner && catalog ? (
          <View style={styles.row}>
            <Button
              kind="secondary"
              label={r.change}
              a11yLabel={`${r.change}: ${category.name}`}
              onPress={() => {
                setInfo('');
                setError('');
                setEditing(null);
                setCatForm({ id: category.id, form: categoryForm(category, catalog) });
              }}
            />
            <Button
              kind="link"
              label={r.remove}
              a11yLabel={`${r.remove}: ${category.name}`}
              onPress={() => setRemoving(category.id)}
            />
          </View>
        ) : null}
      </Card>
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
      {error ? <ErrorText>{error}</ErrorText> : null}

      {!catalog ? (
        !error ? (
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
  input: {
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
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 15, color: colors.ink },
  seg: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.card,
  },
  segText: { fontSize: 14, color: colors.ink },
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
