'use client';

import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, refreshSession, setAccessToken } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { Location, Me, PermissionCatalog, Role } from '@/lib/types';
import { Spinner } from './ui';

interface SessionValue {
  me: Me;
  orgId: string;
  role: Role;
  permissions: PermissionCatalog['me']['permissions'];
  locations: Location[];
  location: Location;
  setLocationId: (id: string) => void;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

const remember = (key: string, value?: string): string | null => {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/**
 * Signs the user in from the refresh cookie, loads their organizations and the
 * chosen salon. Without an organization the owner is sent to the setup page.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const onboarding = pathname.endsWith('/app/onboarding');
  const [value, setValue] = useState<Omit<SessionValue, 'setLocationId' | 'reload' | 'signOut'>>();
  const [needsOrg, setNeedsOrg] = useState(false);

  const load = useCallback(async () => {
    if (!(await refreshSession())) {
      router.replace(`/${locale}/login`);
      return;
    }
    const me = await api<Me>('/v1/me');
    const org = me.organizations.find((o) => o.id === remember('bp.org')) ?? me.organizations[0];
    if (!org) {
      setNeedsOrg(true);
      if (!onboarding) router.replace(`/${locale}/app/onboarding`);
      return;
    }
    remember('bp.org', org.id);
    const [locations, perms] = await Promise.all([
      api<Location[]>(`/v1/organizations/${org.id}/locations`),
      api<PermissionCatalog>(`/v1/organizations/${org.id}/permissions`),
    ]);
    const location = locations.find((l) => l.id === remember('bp.loc')) ?? locations[0];
    if (!location) {
      setNeedsOrg(true);
      if (!onboarding) router.replace(`/${locale}/app/onboarding`);
      return;
    }
    setNeedsOrg(false);
    setValue({
      me,
      orgId: org.id,
      role: perms.me.role,
      permissions: perms.me.permissions,
      locations,
      location,
    });
  }, [locale, onboarding, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const full = useMemo<SessionValue | undefined>(
    () =>
      value && {
        ...value,
        setLocationId: (id: string) => {
          remember('bp.loc', id);
          const location = value.locations.find((l) => l.id === id);
          if (location) setValue({ ...value, location });
        },
        reload: load,
        signOut: async () => {
          await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
          setAccessToken(null);
          router.replace(`/${locale}/login`);
        },
      },
    [value, load, locale, router],
  );

  if (onboarding && needsOrg) return <>{children}</>;
  if (!full) return <Spinner />;
  return <SessionContext.Provider value={full}>{children}</SessionContext.Provider>;
}
