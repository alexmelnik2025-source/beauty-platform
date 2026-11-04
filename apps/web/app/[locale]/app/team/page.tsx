'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@/components/Session';
import {
  CategorySheet,
  InviteSheet,
  MemberSheet,
  type Category,
  type Member,
  type PermissionDefault,
} from '@/components/team/AccessSheets';
import { StaffSheet, type StaffRow } from '@/components/team/StaffSheet';
import { useSpecialtyText } from '@/components/Specialties';
import { ErrorBox, initials, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';
import type { Invitation } from '@/lib/types';

export default function TeamPage() {
  const { t } = useI18n();
  const specialtyText = useSpecialtyText();
  const session = useSession();
  const { orgId, location, role } = session;
  const isOwner = role === 'owner';
  const base = `/v1/organizations/${orgId}/locations/${location.id}`;
  const [tab, setTab] = useState<'staff' | 'access'>('staff');
  const [staff, setStaff] = useState<StaffRow[] | null>(null);
  const [services, setServices] = useState<{ id: string; name: string; active: boolean }[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [defaults, setDefaults] = useState<PermissionDefault[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [openStaff, setOpenStaff] = useState<StaffRow | 'new' | null>(null);
  const [openMember, setOpenMember] = useState<Member | null>(null);
  const [openCategory, setOpenCategory] = useState<Category | 'new' | null>(null);
  const [invite, setInvite] = useState<{ staffId?: string } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [moving, setMoving] = useState(false);
  // Task 13: the owner or a manager puts the staff in the order clients see them.
  const canOrder = role === 'owner' || role === 'manager';

  const load = useCallback(async () => {
    try {
      const org = `/v1/organizations/${orgId}`;
      const [s, sv, m, c, p, i] = await Promise.all([
        api<StaffRow[]>(`${base}/staff`),
        api<{ id: string; name: string; active: boolean }[]>(`${base}/services`),
        api<Member[]>(`${org}/members`),
        api<Category[]>(`${org}/staff-categories`),
        api<{ permissions: PermissionDefault[] }>(`${org}/permissions`),
        api<Invitation[]>(`${org}/invitations`),
      ]);
      setStaff(s);
      setServices(sv);
      setMembers(m);
      setCategories(c);
      setDefaults(p.permissions);
      setInvitations(i);
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [base, orgId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const done = () => {
    setOpenStaff(null);
    setOpenMember(null);
    setOpenCategory(null);
    void load();
  };

  async function revoke(id: string) {
    try {
      await api(`/v1/organizations/${orgId}/invitations/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  async function move(index: number, by: -1 | 1) {
    if (!staff) return;
    const next = [...staff];
    const [row] = next.splice(index, 1);
    if (!row) return;
    next.splice(index + by, 0, row);
    setStaff(next);
    setMoving(true);
    setError('');
    try {
      setStaff(
        await api<StaffRow[]>(`${base}/staff/order`, {
          method: 'PUT',
          body: { staffIds: next.map((s) => s.id) },
        }),
      );
    } catch (err) {
      setError(errorText(t, err));
      await load();
    } finally {
      setMoving(false);
    }
  }

  if (!staff) return error ? <ErrorBox>{error}</ErrorBox> : <Spinner />;
  const emailOf = (userId: string | null) =>
    members.find((m) => m.user.id === userId)?.user.email ?? null;
  /** The newest invitation for a calendar profile that still waits to be accepted. */
  const pendingFor = (staffId: string) =>
    invitations.find((i) => i.staffMemberId === staffId && i.status === 'pending') ?? null;
  const presetInvite = invite?.staffId ? pendingFor(invite.staffId) : null;

  return (
    <>
      <div className="page-head">
        <h1>{t.team.title}</h1>
        {tab === 'staff' ? (
          <button type="button" className="btn btn--small" onClick={() => setOpenStaff('new')}>
            + {t.team.addStaff}
          </button>
        ) : (
          <button type="button" className="btn btn--small" onClick={() => setInvite({})}>
            + {t.team.invite}
          </button>
        )}
      </div>
      <div className="page">
        <div className="tabs" role="group" style={{ maxWidth: 420 }}>
          <button type="button" aria-pressed={tab === 'staff'} onClick={() => setTab('staff')}>
            {t.team.tabStaff}
          </button>
          <button type="button" aria-pressed={tab === 'access'} onClick={() => setTab('access')}>
            {t.team.tabAccess}
          </button>
        </div>
        <ErrorBox>{error}</ErrorBox>
        {message ? (
          <p className="note" role="status">
            {message}
          </p>
        ) : null}

        {tab === 'staff' ? (
          staff.length === 0 ? (
            <p className="note">{t.team.empty}</p>
          ) : (
            <>
              {canOrder && staff.length > 1 ? (
                <p className="small muted">{t.team.orderHint}</p>
              ) : null}
              <ul className="list">
                {staff.map((s, index) => (
                  <li key={s.id} className={canOrder && staff.length > 1 ? 'orderable' : undefined}>
                    <button type="button" className="list-row" onClick={() => setOpenStaff(s)}>
                      <span className="avatar" aria-hidden="true">
                        {s.photoUrl ? <img src={s.photoUrl} alt="" /> : initials(s.displayName)}
                      </span>
                      <span className="grow">
                        <strong>{s.displayName}</strong>
                        {specialtyText(s.specialties, s.customSpecialty) ? (
                          <span className="small">
                            {specialtyText(s.specialties, s.customSpecialty)}
                          </span>
                        ) : null}
                        <span className="small muted">
                          {s.serviceIds.length} ·{' '}
                          {s.userId
                            ? (emailOf(s.userId) ?? '✓')
                            : pendingFor(s.id)
                              ? t.team.invitedShort
                              : t.team.notLinked.split('.')[0]}
                        </span>
                      </span>
                      {s.active ? null : <span className="chip">{t.services.hidden}</span>}
                    </button>
                    {canOrder && staff.length > 1 ? (
                      <span className="order-btns">
                        <button
                          type="button"
                          aria-label={fill(t.team.moveUp, { name: s.displayName })}
                          disabled={moving || index === 0}
                          onClick={() => void move(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={fill(t.team.moveDown, { name: s.displayName })}
                          disabled={moving || index === staff.length - 1}
                          onClick={() => void move(index, 1)}
                        >
                          ↓
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )
        ) : (
          <>
            <section className="section">
              <h2>{t.team.people}</h2>
              <ul className="list">
                {members.map((m) => (
                  <li key={m.membershipId}>
                    <button type="button" className="list-row" onClick={() => setOpenMember(m)}>
                      <span className="avatar" aria-hidden="true">
                        {initials(m.user.name)}
                      </span>
                      <span className="grow">
                        <strong>{m.user.name}</strong>
                        <span className="small muted">
                          {t.team.roles[m.role]}
                          {m.role === 'staff'
                            ? ` · ${categories.find((c) => c.id === m.staffCategoryId)?.name ?? t.team.defaultPerms}`
                            : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            {invitations.length ? (
              <section className="section">
                <h2>{t.team.invitations}</h2>
                <ul className="history">
                  {invitations.map((i) => (
                    <li key={i.id}>
                      <span>
                        {i.email}
                        {i.phone ? ` · ${i.phone}` : ''} · {t.team.roles[i.role]}{' '}
                        <span className="chip">{t.team.invitationStatus[i.status]}</span>
                      </span>
                      {i.status === 'pending' ? (
                        <button
                          type="button"
                          className="link-btn small"
                          onClick={() => void revoke(i.id)}
                        >
                          {t.team.revoke}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="section">
              <div className="row" style={{ alignItems: 'center' }}>
                <h2 style={{ flex: '1 1 auto' }}>{t.team.categories}</h2>
                {isOwner ? (
                  <button
                    type="button"
                    className="btn btn--quiet btn--small"
                    style={{ flex: '0 0 auto' }}
                    onClick={() => setOpenCategory('new')}
                  >
                    + {t.team.addCategory}
                  </button>
                ) : null}
              </div>
              <ul className="list">
                {categories.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="list-row"
                      disabled={!isOwner}
                      onClick={() => setOpenCategory(c)}
                    >
                      <span className="grow">
                        <strong>{c.name}</strong>
                        <span className="small muted">
                          {fill(t.team.members, { count: String(c.memberCount) })}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>

      {openStaff ? (
        <StaffSheet
          base={base}
          staff={openStaff === 'new' ? null : openStaff}
          services={services}
          memberEmail={openStaff === 'new' ? null : emailOf(openStaff.userId)}
          pendingInvitation={openStaff === 'new' ? null : pendingFor(openStaff.id)}
          onInvite={(s) => {
            setOpenStaff(null);
            setInvite({ staffId: s.id });
          }}
          onClose={() => setOpenStaff(null)}
          onSaved={done}
          onPhotoChange={() => void load()}
        />
      ) : null}
      {openMember ? (
        <MemberSheet
          orgId={orgId}
          member={openMember}
          categories={categories}
          defaults={defaults}
          canEdit={isOwner}
          onClose={() => setOpenMember(null)}
          onSaved={done}
        />
      ) : null}
      {openCategory ? (
        <CategorySheet
          orgId={orgId}
          category={openCategory === 'new' ? null : openCategory}
          defaults={defaults}
          onClose={() => setOpenCategory(null)}
          onSaved={done}
        />
      ) : null}
      {invite ? (
        <InviteSheet
          orgId={orgId}
          locationId={location.id}
          isOwner={isOwner}
          staffProfiles={staff}
          categories={categories}
          presetStaffId={invite.staffId}
          presetEmail={presetInvite?.email}
          presetPhone={presetInvite?.phone ?? undefined}
          onClose={() => setInvite(null)}
          onSent={(email) => {
            setInvite(null);
            setMessage(fill(t.team.inviteSent, { email }));
            setTab('access');
            void load();
          }}
        />
      ) : null}
    </>
  );
}
