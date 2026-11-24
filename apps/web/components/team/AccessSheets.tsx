'use client';

import { LanguagePicker, type Spoken } from '../Languages';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '@/lib/api';
import { EMAIL_SHAPE, PHONE_SHAPE } from '@/lib/contact-check';
import { DASHBOARD_LOCALES, errorText, localeCode, useI18n } from '@/lib/i18n';
import type { Member, PermissionCatalog, PermissionMap, StaffCategory } from '@/lib/types';
import { FieldError, Sheet } from '../ui';

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
  /**
   * Task 796 (owner's rule: errors where the action is): a refused "Zapisz" or "Usuń z zespołu" is
   * said in the sheet's footer under the pressed button, not at the top of a long list of rights.
   */
  const [error, setError] = useState<{ action: 'save' | 'remove'; text: string } | null>(null);
  const described = (action: 'save' | 'remove') =>
    error?.action === action ? { 'aria-describedby': 'member-action-error' } : {};
  const [busy, setBusy] = useState(false);
  const isStaff = member.role === 'staff';

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/organizations/${orgId}/members/${member.membershipId}/permissions`, {
        method: 'PUT',
        body: { version: member.version, staffCategoryId: categoryId || null, overrides },
      });
      onSaved();
    } catch (err) {
      setError({ action: 'save', text: errorText(t, err) });
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/organizations/${orgId}/members/${member.membershipId}`, { method: 'DELETE' });
      onSaved();
    } catch (err) {
      setError({ action: 'remove', text: errorText(t, err) });
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
              <button
                type="button"
                className="btn"
                disabled={busy}
                {...described('save')}
                onClick={() => void save()}
              >
                {t.common.save}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy}
              {...described('remove')}
              onClick={() => void remove()}
            >
              {t.team.remove}
            </button>
            {error ? (
              <span style={{ flexBasis: '100%' }}>
                <FieldError id="member-action-error" text={error.text} />
              </span>
            ) : null}
          </>
        ) : undefined
      }
    >
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

/** The server said the category's name is wrong (empty after trimming, too long). */
function namePathOf(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return false;
  if (!Array.isArray(err.details)) return false;
  return (err.details as { path?: string }[]).some((d) => String(d.path ?? '') === 'name');
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
  /**
   * Task 818 (owner's rule: errors where the action is): a refused "Zapisz" (that names no field)
   * or "Usuń" is said under the pressed button at the bottom of the sheet, not above the form.
   */
  const [error, setError] = useState<{ action: 'save' | 'remove'; text: string } | null>(null);
  const describedBy = (action: 'save' | 'remove') =>
    error?.action === action ? `category-${action}-error` : undefined;
  const [busy, setBusy] = useState(false);
  /**
   * Task 683 (owner's rule: errors at the field): an empty name used to get the browser's
   * tooltip, and the server's answer about the name was a line above the form; now
   * "Uzupełnij to pole." (or the server's words) is said under the name field.
   */
  const [nameProblem, setNameProblem] = useState('');

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) {
      setError(null);
      setNameProblem(t.onboarding.fieldRequired);
      e.currentTarget.querySelector<HTMLInputElement>('input[name="category-name"]')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setNameProblem('');
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
      if (namePathOf(err)) setNameProblem(errorText(t, err));
      else setError({ action: 'save', text: errorText(t, err) });
      setBusy(false);
    }
  }

  async function remove() {
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/organizations/${orgId}/staff-categories/${category.id}`, { method: 'DELETE' });
      onSaved();
    } catch (err) {
      setError({ action: 'remove', text: errorText(t, err) });
      setBusy(false);
    }
  }

  return (
    <Sheet title={category?.name ?? t.team.addCategory} onClose={onClose}>
      <form className="form" noValidate onSubmit={save}>
        <label className="field">
          <span>{t.team.categoryName}</span>
          <input
            name="category-name"
            required
            maxLength={60}
            value={name}
            aria-invalid={nameProblem ? true : undefined}
            aria-describedby={nameProblem ? 'category-name-error' : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setNameProblem('');
              setError(null);
            }}
          />
          <FieldError id="category-name-error" text={nameProblem} />
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
                onChange={(e) => {
                  setPerms({ ...perms, [p.key]: e.target.checked });
                  setError(null);
                }}
              />
              <span>{labels[p.key] ?? p.key}</span>
            </label>
          ))}
        </div>
        <button className="btn btn--block" disabled={busy} aria-describedby={describedBy('save')}>
          {t.common.save}
        </button>
        <FieldError
          id="category-save-error"
          text={error?.action === 'save' ? error.text : undefined}
        />
        {category ? (
          <button
            type="button"
            className="btn btn--danger btn--block"
            disabled={busy}
            aria-describedby={describedBy('remove')}
            onClick={() => void remove()}
          >
            {t.actions.delete}
          </button>
        ) : null}
        <FieldError
          id="category-remove-error"
          text={error?.action === 'remove' ? error.text : undefined}
        />
      </form>
    </Sheet>
  );
}

/** Task 667: the invitation's fields that can show an error under them. */
type InviteField = 'email' | 'phone' | 'staffMemberId' | 'staffCategoryId';

/** Which field the server's answer is about; null when it is about something else. */
function inviteFieldOf(err: unknown): InviteField | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'ALREADY_MEMBER') return 'email';
  if (err.code === 'STAFF_ALREADY_LINKED') return 'staffMemberId';
  if (err.code !== 'VALIDATION_ERROR' || !Array.isArray(err.details)) return null;
  const paths = (err.details as { path?: string }[]).map((d) => d.path);
  const fields: InviteField[] = ['email', 'phone', 'staffMemberId', 'staffCategoryId'];
  return fields.find((f) => paths.includes(f)) ?? null;
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
  /**
   * Task 667 (owner's rule: errors at the field): a wrong e-mail or phone, "already in the team"
   * and "this profile has an account" are said under their own field; editing it takes it away.
   */
  const [problem, setProblem] = useState<{ field: InviteField; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    setError('');
    // Task 699: an empty or wrong e-mail or phone — said under the field before sending, instead
    // of the browser's bubble; the cursor goes there.
    const email = form.email.trim();
    const phone = form.phone.replace(/[\s()-]/g, '');
    const local: { field: InviteField; text: string } | null = !email
      ? { field: 'email', text: t.onboarding.fieldRequired }
      : !EMAIL_SHAPE.test(email)
        ? { field: 'email', text: t.booking.emailInvalid }
        : !phone
          ? { field: 'phone', text: t.onboarding.fieldRequired }
          : !PHONE_SHAPE.test(phone)
            ? { field: 'phone', text: t.booking.phoneInvalid }
            : null;
    setProblem(local);
    if (local) {
      document.getElementById(`invite-${local.field}`)?.focus();
      return;
    }
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
      const field = inviteFieldOf(err);
      const text: Record<InviteField, string> = {
        email: t.booking.emailInvalid,
        phone: t.booking.phoneInvalid,
        staffMemberId: t.errors.VALIDATION_ERROR,
        staffCategoryId: t.errors.VALIDATION_ERROR,
      };
      if (field) {
        const known = err instanceof ApiError && err.code !== 'VALIDATION_ERROR';
        setProblem({ field, text: known ? errorText(t, err) : text[field] });
      } else setError(errorText(t, err));
      setBusy(false);
    }
  }

  /** Editing a field takes its error away (and the refused-send line under "Zaproś"). */
  const edit = (field: InviteField, change: Partial<typeof form>) => {
    setForm({ ...form, ...change });
    setError('');
    if (problem?.field === field) setProblem(null);
  };
  const invalid = (field: InviteField) => ({
    id: `invite-${field}`,
    'aria-invalid': problem?.field === field || undefined,
    'aria-describedby': problem?.field === field ? `invite-${field}-error` : undefined,
  });
  const fieldError = (field: InviteField) => (
    <FieldError
      id={`invite-${field}-error`}
      text={problem?.field === field ? problem.text : undefined}
    />
  );

  return (
    <Sheet title={t.team.inviteTitle} onClose={onClose}>
      <form noValidate className="form" onSubmit={send}>
        <label className="field">
          <span>{t.team.inviteEmail}</span>
          <input
            type="email"
            required
            value={form.email}
            {...invalid('email')}
            onChange={(e) => edit('email', { email: e.target.value })}
          />
          {fieldError('email')}
        </label>
        <label className="field">
          <span>{t.team.invitePhone}</span>
          <input
            type="tel"
            required
            autoComplete="off"
            placeholder="+48 600 100 200"
            value={form.phone}
            {...invalid('phone')}
            onChange={(e) => edit('phone', { phone: e.target.value })}
          />
          {fieldError('phone')}
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
                {...invalid('staffMemberId')}
                onChange={(e) =>
                  edit('staffMemberId', {
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
              {fieldError('staffMemberId')}
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
                {...invalid('staffCategoryId')}
                onChange={(e) => edit('staffCategoryId', { staffCategoryId: e.target.value })}
              >
                <option value="">{t.team.defaultPerms}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {fieldError('staffCategoryId')}
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
                {localeCode(l)}
              </option>
            ))}
          </select>
        </label>
        {/* Task 819 (owner's rule: errors where the action is): a refused "Zaproś" that names no
            field is said under this button, not above the form; the typed data stays. */}
        <button
          className="btn btn--block"
          disabled={busy}
          aria-describedby={error ? 'invite-send-error' : undefined}
        >
          {t.team.invite}
        </button>
        <FieldError id="invite-send-error" text={error} />
      </form>
    </Sheet>
  );
}
