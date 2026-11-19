import type { Metadata } from 'next';
import { BookingFlow } from '@/components/booking/BookingFlow';
import { isLocale } from '@/lib/i18n/locales';
import { smartAppBannerContent, storeLinksFromEnv } from '@/lib/install-banner';
import {
  jsonForScript,
  publicRating,
  publicSalon,
  salonJsonLd,
  salonMetadata,
  siteUrl,
} from '@/lib/seo';

type Params = Promise<{ locale: string; slug: string }>;

/** Title, description, link preview and language versions of the salon (task 130). */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const salon = await publicSalon(slug);
  if (!salon) return { robots: { index: false } };
  // Task Q2: the booking page can install "My visits" (the browser's install prompt needs a
  // manifest on the page); Safari shows its own App Store banner once the app has an id.
  const smartBanner = smartAppBannerContent(
    storeLinksFromEnv(),
    `${siteUrl()}/${locale}/b/${salon.slug}`,
  );
  return {
    ...salonMetadata(salon, locale),
    manifest: `/manifests/visits-${locale}.webmanifest`,
    ...(smartBanner ? { other: { 'apple-itunes-app': smartBanner } } : {}),
  };
}

export default async function BookingPage({ params }: { params: Params }) {
  const { locale, slug } = await params;
  const [salon, rating] = isLocale(locale)
    ? await Promise.all([publicSalon(slug), publicRating(slug)])
    : [null, null];
  return (
    <>
      {salon && isLocale(locale) ? (
        <script
          type="application/ld+json"
          // Escaped JSON (no "<"): the salon's own texts cannot end the script tag.
          dangerouslySetInnerHTML={{ __html: jsonForScript(salonJsonLd(salon, locale, rating)) }}
        />
      ) : null}
      <BookingFlow slug={slug} stores={storeLinksFromEnv()} />
    </>
  );
}
