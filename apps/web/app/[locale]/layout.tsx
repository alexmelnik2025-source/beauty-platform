import type { Metadata, Viewport } from 'next';
import { Michroma } from 'next/font/google';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n';
import { isLocale, LOCALES } from '@/lib/i18n/locales';
import '../globals.css';

// Display face of the GESTALT brand (headings, wordmark, clock numerals).
// It has no Cyrillic letters: Ukrainian and Russian headings fall back to the body face.
const display = Michroma({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'GESTALT', template: '%s · GESTALT' },
  robots: { index: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffffff',
};

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <html lang={locale} className={display.variable}>
      <body>
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
