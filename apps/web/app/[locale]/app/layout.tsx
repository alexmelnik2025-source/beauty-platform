import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CabinetLayout } from '@/components/CabinetLayout';
import { DASHBOARD_LOCALES, isLocale } from '@/lib/i18n/locales';

/** The cabinet can be installed as an app; its manifest follows the interface language. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  // tr and sq have no dashboard of their own yet: the app installs in English.
  const lang = isLocale(locale) ? (DASHBOARD_LOCALES.includes(locale) ? locale : 'en') : 'pl';
  return {
    manifest: `/manifests/salon-${lang}.webmanifest`,
    appleWebApp: { capable: true, title: 'GESTALT', statusBarStyle: 'default' },
    icons: { apple: '/icons/apple-touch-icon.png' },
  };
}

export default function Layout({ children }: { children: ReactNode }) {
  return <CabinetLayout>{children}</CabinetLayout>;
}
