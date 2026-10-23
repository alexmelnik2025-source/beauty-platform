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
import { ErrorBox, initials, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';

interface Invitation {
  id: string;
  email: string;
  role: 'manager' | 'staff';
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
}

export default function TeamPage() {
  const { t } = useI18n();
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

  if (!staff) return error ? <ErrorBox>{error}</ErrorBox> : <Spinner />;
  const emailOf = (userId: string | null) =>
    members.find((m) => m.user.id === userId)?.user.email ?? null;

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
            <ul className="list">
              {staff.map((s) => (
                <li key={s.id}>
                  <button type="button" className="list-row" onClick={() => setOpenStaff(s)}>
                    <span className="avatar" aria-hidden="true">
                      {initials(s.displayName)}
                    </span>
                    <span className="grow">
                      <strong>{s.displayName}</strong>
                      <span className="small muted">
                        {t.nav.services}: {s.serviceIds.length} ·{' '}
                        {s.userId ? (emailOf(s.userId) ?? '✓') : t.team.notLinked.split('.')[0]}
                      </span>
                    </span>
                    {s.active ? null : <span className="chip">{t.services.hidden}</span>}
                  </button>
                </li>
              ))}
            </ul>
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
                        {i.email} · {t.team.roles[i.role]}{' '}
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
          onInvite={(s) => {
            setOpenStaff(null);
            setInvite({ staffId: s.id });
          }}
          onClose={() => setOpenStaff(null)}
          onSaved={done}
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
