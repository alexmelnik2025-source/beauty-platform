'use client';

import { LanguagePicker, type Spoken } from '../Languages';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { DASHBOARD_LOCALES, errorText, useI18n } from '@/lib/i18n';
import type { Member, PermissionCatalog, PermissionMap, StaffCategory } from '@/lib/types';
import { ErrorBox, Sheet } from '../ui';

export type { Member, PermissionMap };
export type Category = StaffCategory;
export type PermissionDefault = PermissionCatalog['permissions'][number];

/** "As in the category / yes / no" for one permission. */
function Tri({
  value,
  onChange,
  label,
}: {
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
  label: string;
}) {
  const { t } = useI18n();
  return (
    <span className="seg" role="group" aria-label={label}>
      <button type="button" aria-pressed={value === undefined} onClick={() => onChange(undefined)}>
        {t.team.asCategory}
      </button>
      <button type="button" aria-pressed={value === true} onClick={() => onChange(true)}>
        {t.team.allow}
      </button>
      <button type="button" aria-pressed={value === false} onClick={() => onChange(false)}>
        {t.team.deny}
      </button>
    </span>
  );
}

export function MemberSheet({
  orgId,
  member,
  categories,
  defaults,
  canEdit,
  onClose,
  onSaved,
}: {
  orgId: string;
  member: Member;
  categories: Category[];
  defaults: PermissionDefault[];
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const labels = t.team.permissions as Record<string, string>;
  const [categoryId, setCategoryId] = useState(member.staffCategoryId ?? '');
  const [overrides, setOverrides] = useState<PermissionMap>(member.overrides);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isStaff = member.role === 'staff';

  async function save() {
    setBusy(true);
    try {
      await api(`/v1/organizations/${orgId}/members/${member.membershipId}/permissions`, {
        method: 'PUT',
        body: { version: member.version, staffCategoryId: categoryId || null, overrides },
      });
      onSaved();
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`/v1/organizations/${orgId}/members/${member.membershipId}`, { method: 'DELETE' });
      onSaved();
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={member.user.name}
      onClose={onClose}
      footer={
        canEdit && member.role !== 'owner' ? (
          <>
            {isStaff ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
                {t.common.save}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t.team.remove}
            </button>
          </>
        ) : undefined
      }
    >
      <ErrorBox>{error}</ErrorBox>
      <p className="small muted">
        {member.user.email} · {t.team.roles[member.role]}
      </p>
      {isStaff ? (
        <>
          <label className="field">
            <span>{t.team.permCategory}</span>
            <select
              disabled={!canEdit}
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">{t.team.defaultPerms}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <section className="section">
            <h3>{t.team.exceptions}</h3>
            <div className="perm-grid">
              {defaults.map((p) => (
                <div key={p.key} className="perm-row">
                  <span>
                    {labels[p.key] ?? p.key}
                    <span className="small muted">
                      {' '}
                      · {member.permissions[p.key] ? t.team.allow : t.team.deny}
                    </span>
                  </span>
                  {canEdit ? (
                    <Tri
                      label={labels[p.key] ?? p.key}
                      value={overrides[p.key]}
                      onChange={(value) => {
                        const next = { ...overrides };
                        if (value === undefined) delete next[p.key];
                        else next[p.key] = value;
                        setOverrides(next);
                      }}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        </>
      ) : null}
      {canEdit && member.role !== 'owner' ? (
        <p className="small muted">{t.team.removeHint}</p>
      ) : null}
    </Sheet>
  );
}

export function CategorySheet({
  orgId,
  category,
  defaults,
  onClose,
  onSaved,
}: {
  orgId: string;
  category: Category | null;
  defaults: PermissionDefault[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const labels = t.team.permissions as Record<string, string>;
  const [name, setName] = useState(category?.name ?? '');
  const [perms, setPerms] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(defaults.map((p) => [p.key, category?.permissions[p.key] ?? p.default])),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (category) {
        await api(`/v1/organizations/${orgId}/staff-categories/${category.id}`, {
          method: 'PATCH',
          body: { version: category.version, name, permissions: perms },
        });
      } else {
        await api(`/v1/organizations/${orgId}/staff-categories`, {
          method: 'POST',
          body: { name, permissions: perms },
        });
      }
      onSaved();
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!category) return;
    setBusy(true);
    try {
      await api(`/v1/organizations/${orgId}/staff-categories/${category.id}`, { method: 'DELETE' });
      onSaved();
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <Sheet title={category?.name ?? t.team.addCategory} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <ErrorBox>{error}</ErrorBox>
        <label className="field">
          <span>{t.team.categoryName}</span>
          <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="perm-grid">
          {defaults.map((p) => (
            <label
              key={p.key}
              className="check perm-row"
              style={{ gridTemplateColumns: '22px 1fr' }}
            >
              <input
                type="checkbox"
                checked={perms[p.key] ?? false}
                onChange={(e) => setPerms({ ...perms, [p.key]: e.target.checked })}
              />
              <span>{labels[p.key] ?? p.key}</span>
            </label>
          ))}
        </div>
        <button className="btn btn--block" disabled={busy}>
          {t.common.save}
        </button>
        {category ? (
          <button
            type="button"
            className="btn btn--danger btn--block"
            disabled={busy}
            onClick={() => void remove()}
          >
            {t.actions.delete}
          </button>
        ) : null}
      </form>
    </Sheet>
  );
}

export function InviteSheet({
  orgId,
  locationId,
  isOwner,
  staffProfiles,
  categories,
  presetStaffId,
  presetEmail,
  presetPhone,
  onClose,
  onSent,
}: {
  orgId: string;
  locationId: string;
  isOwner: boolean;
  staffProfiles: { id: string; displayName: string; userId: string | null; languages?: Spoken[] }[];
  categories: Category[];
  presetStaffId?: string;
  /** "Send again": the address and number of the previous invitation. */
  presetEmail?: string;
  presetPhone?: string;
  onClose: () => void;
  onSent: (email: string) => void;
}) {
  const { t, locale } = useI18n();
  const [form, setForm] = useState({
    email: presetEmail ?? '',
    phone: presetPhone ?? '',
    role: 'staff' as 'staff' | 'manager',
    staffMemberId: presetStaffId ?? '',
    staffCategoryId: '',
    locale: locale as string,
    // Task 81: the staff profile's languages, set right away with the invitation.
    languages: staffProfiles.find((s) => s.id === presetStaffId)?.languages ?? ([] as Spoken[]),
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/v1/organizations/${orgId}/invitations`, {
        method: 'POST',
        body: {
          email: form.email,
          phone: form.phone,
          role: form.role,
          locationIds: [locationId],
          locale: form.locale,
          ...(form.role === 'staff' && form.staffMemberId
            ? { staffMemberId: form.staffMemberId, languages: form.languages }
            : {}),
          ...(form.role === 'staff' && form.staffCategoryId
            ? { staffCategoryId: form.staffCategoryId }
            : {}),
        },
      });
      onSent(form.email);
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <Sheet title={t.team.inviteTitle} onClose={onClose}>
      <form className="form" onSubmit={send}>
        <ErrorBox>{error}</ErrorBox>
        <label className="field">
          <span>{t.team.inviteEmail}</span>
          <input
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label className="field">
          <span>{t.team.invitePhone}</span>
          <input
            type="tel"
            required
            autoComplete="off"
            placeholder="+48 600 100 200"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
          <span className="small muted">{t.team.invitePhoneHint}</span>
        </label>
        {isOwner ? (
          <label className="field">
            <span>{t.team.inviteRole}</span>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as 'staff' | 'manager' })}
            >
              <option value="staff">{t.team.roles.staff}</option>
              <option value="manager">{t.team.roles.manager}</option>
            </select>
          </label>
        ) : null}
        {form.role === 'staff' ? (
          <>
            <label className="field">
              <span>{t.team.inviteProfile}</span>
              <select
                value={form.staffMemberId}
                onChange={(e) =>
                  setForm({
                    ...form,
                    staffMemberId: e.target.value,
                    languages: staffProfiles.find((s) => s.id === e.target.value)?.languages ?? [],
                  })
                }
              >
                <option value="">{t.team.inviteNoProfile}</option>
                {staffProfiles
                  .filter((s) => !s.userId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayName}
                    </option>
                  ))}
              </select>
            </label>
            {form.staffMemberId ? (
              <LanguagePicker
                title={t.languages.staffTitle}
                hint={t.languages.staffHint}
                value={form.languages}
                onChange={(languages) => setForm({ ...form, languages })}
              />
            ) : null}
            <label className="field">
              <span>{t.team.permCategory}</span>
              <select
                value={form.staffCategoryId}
                onChange={(e) => setForm({ ...form, staffCategoryId: e.target.value })}
              >
                <option value="">{t.team.defaultPerms}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        <label className="field">
          <span>{t.more.language}</span>
          <select
            value={form.locale}
            onChange={(e) => setForm({ ...form, locale: e.target.value })}
          >
            {DASHBOARD_LOCALES.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn--block" disabled={busy}>
          {t.team.invite}
        </button>
      </form>
    </Sheet>
  );
}
