import type { Metadata } from 'next';
import { PublicDirectory } from '@/components/PublicDirectory';
import { DICTIONARIES, isLocale } from '@/lib/i18n/locales';
import { languageVersions, robots } from '@/lib/seo';

// Indexing is switched on by the server's settings (PUBLIC_INDEXING), not at build time.
export const dynamic = 'force-dynamic';

/** Title, description and language versions of the catalogue (task 130). */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = DICTIONARIES[locale].seo;
  return {
    title: t.catalogTitle,
    description: t.catalogDescription,
    robots: robots(),
    alternates: languageVersions(locale, '/salons'),
    openGraph: { type: 'website', title: t.catalogTitle, description: t.catalogDescription },
  };
}

export default function SalonsPage() {
  return <PublicDirectory />;
}
