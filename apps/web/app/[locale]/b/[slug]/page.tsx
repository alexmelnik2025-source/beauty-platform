import type { Metadata } from 'next';
import { BookingFlow } from '@/components/booking/BookingFlow';
import { isLocale } from '@/lib/i18n/locales';
import { jsonForScript, publicSalon, salonJsonLd, salonMetadata } from '@/lib/seo';

type Params = Promise<{ locale: string; slug: string }>;

/** Title, description, link preview and language versions of the salon (task 130). */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const salon = await publicSalon(slug);
  return salon ? salonMetadata(salon, locale) : { robots: { index: false } };
}

export default async function BookingPage({ params }: { params: Params }) {
  const { locale, slug } = await params;
  const salon = isLocale(locale) ? await publicSalon(slug) : null;
  return (
    <>
      {salon && isLocale(locale) ? (
        <script
          type="application/ld+json"
          // Escaped JSON (no "<"): the salon's own texts cannot end the script tag.
          dangerouslySetInnerHTML={{ __html: jsonForScript(salonJsonLd(salon, locale)) }}
        />
      ) : null}
      <BookingFlow slug={slug} />
    </>
  );
}
