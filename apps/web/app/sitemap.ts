import type { MetadataRoute } from 'next';
import { LOCALE_TAGS, LOCALES } from '@/lib/i18n/locales';
import { publicSalonSlugs, siteUrl } from '@/lib/seo';

// The list of salons changes as salons switch online booking on and off.
export const dynamic = 'force-dynamic';

/** sitemap.xml (task 130): the catalogue and every salon open for online booking, in each language. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const page = (path: string): MetadataRoute.Sitemap =>
    LOCALES.map((locale) => ({
      url: `${base}/${locale}${path}`,
      alternates: {
        languages: Object.fromEntries(LOCALES.map((l) => [LOCALE_TAGS[l], `${base}/${l}${path}`])),
      },
    }));
  const slugs = await publicSalonSlugs();
  return [...page('/salons'), ...slugs.flatMap((slug) => page(`/b/${slug}`))];
}
