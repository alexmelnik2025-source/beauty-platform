import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ClientAppShell } from '@/components/client/ClientAppShell';
import { DICTIONARIES, isLocale } from '@/lib/i18n/locales';

/** "My visits" installs as its own app (separate from the salon cabinet), in the page's language. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const lang = isLocale(locale) ? locale : 'pl';
  return {
    title: DICTIONARIES[lang].visits.title,
    manifest: `/manifests/visits-${lang}.webmanifest`,
    appleWebApp: {
      capable: true,
      title: DICTIONARIES[lang].visits.appName,
      statusBarStyle: 'default',
    },
    icons: { apple: '/icons/apple-touch-icon.png' },
  };
}

export default function Layout({ children }: { children: ReactNode }) {
  return <ClientAppShell>{children}</ClientAppShell>;
}
