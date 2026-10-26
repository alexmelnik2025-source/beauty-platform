import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CabinetLayout } from '@/components/CabinetLayout';
import { isLocale } from '@/lib/i18n/locales';

/** The cabinet can be installed as an app; its manifest follows the interface language. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const lang = isLocale(locale) ? locale : 'pl';
  return {
    manifest: `/manifests/salon-${lang}.webmanifest`,
    appleWebApp: { capable: true, title: 'GESTALT', statusBarStyle: 'default' },
    icons: { apple: '/icons/apple-touch-icon.png' },
  };
}

export default function Layout({ children }: { children: ReactNode }) {
  return <CabinetLayout>{children}</CabinetLayout>;
}
