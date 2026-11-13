import type { Metadata } from 'next';
import { DICTIONARIES, fill, LOCALE_TAGS, LOCALES, type Locale } from './i18n/locales';
import type { PublicLocation, PublicReviews } from './types';

/**
 * Search engines (task 130). Public pages (the salon catalogue and each salon's booking page)
 * carry a title, a description, link previews, language versions and data for Google. They are
 * indexed only when the server says so (PUBLIC_INDEXING=1, switched on by the owner at launch);
 * the salon dashboard, "My visits" and visit links are never indexed.
 */

/** Read at request time, so that one Docker image works with indexing both on and off. */
export function indexingEnabled(): boolean {
  return process.env.PUBLIC_INDEXING === '1';
}

/** The public address of the web app, without a trailing slash. */
export function siteUrl(): string {
  return (process.env.APP_WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

/** Where the server side of the web app reaches the API (the browser goes through /v1). */
function apiUrl(): string {
  return (process.env.API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
}

export function robots(): Metadata['robots'] {
  return indexingEnabled() ? { index: true, follow: true } : { index: false, follow: false };
}

/** The same page in every language: canonical address and hreflang links. */
export function languageVersions(locale: Locale, path: string): Metadata['alternates'] {
  const base = siteUrl();
  const languages: Record<string, string> = {};
  for (const l of LOCALES) languages[LOCALE_TAGS[l]] = `${base}/${l}${path}`;
  languages['x-default'] = `${base}/pl${path}`;
  return { canonical: `${base}/${locale}${path}`, languages };
}

/** The salon as the booking page shows it, or null when it is not open for online booking. */
export async function publicSalon(slug: string): Promise<PublicLocation | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  try {
    const res = await fetch(`${apiUrl()}/v1/public/locations/${slug}`, {
      next: { revalidate: 300 },
    });
    return res.ok ? ((await res.json()) as PublicLocation) : null;
  } catch {
    return null;
  }
}

/**
 * Task 410: the salon's stars for search engines — the average and the number of its reviews;
 * null while it does not collect reviews or has none (as on the page).
 */
export async function publicRating(
  slug: string,
): Promise<{ average: number; count: number } | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  try {
    const res = await fetch(`${apiUrl()}/v1/public/locations/${slug}/reviews`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as PublicReviews;
    return body.enabled && body.count > 0 && body.average !== null
      ? { average: body.average, count: body.count }
      : null;
  } catch {
    return null;
  }
}

/** Every salon of the catalogue (online booking on), for the sitemap. */
export async function publicSalonSlugs(): Promise<string[]> {
  const slugs: string[] = [];
  try {
    for (let page = 1; page <= 200; page++) {
      const res = await fetch(`${apiUrl()}/v1/public/locations?page=${page}&pageSize=50`, {
        next: { revalidate: 3600 },
      });
      if (!res.ok) break;
      const body = (await res.json()) as { items: { slug: string }[]; pageCount: number };
      slugs.push(...body.items.map((i) => i.slug));
      if (page >= body.pageCount) break;
    }
  } catch {
    // The sitemap still lists the catalogue when the API cannot be reached.
  }
  return slugs;
}

export function salonMetadata(salon: PublicLocation, locale: Locale): Metadata {
  const t = DICTIONARIES[locale].seo;
  const values = { name: salon.name, city: salon.city, address: salon.addressLine };
  const description = salon.description?.trim()
    ? salon.description.trim().replace(/\s+/g, ' ').slice(0, 300)
    : fill(t.salonDescription, values);
  const title = fill(t.salonTitle, values);
  const photo = salon.photos[0];
  return {
    // The whole title: the salon's name, not "… · GESTALT".
    title: { absolute: title },
    description,
    robots: robots(),
    alternates: languageVersions(locale, `/b/${salon.slug}`),
    openGraph: {
      type: 'website',
      title,
      description,
      url: `${siteUrl()}/${locale}/b/${salon.slug}`,
      siteName: salon.name,
      locale: LOCALE_TAGS[locale].replace('-', '_'),
      ...(photo ? { images: [{ url: `${siteUrl()}${photo.url}` }] } : {}),
    },
  };
}

const DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** schema.org data of the salon: what Google shows next to the search result. */
export function salonJsonLd(
  salon: PublicLocation,
  locale: Locale,
  rating: { average: number; count: number } | null = null,
): Record<string, unknown> {
  const url = `${siteUrl()}/${locale}/b/${salon.slug}`;
  const price = (hundredths: number) => (hundredths / 100).toFixed(2);
  return {
    '@context': 'https://schema.org',
    '@type': 'BeautySalon',
    '@id': `${siteUrl()}/b/${salon.slug}#salon`,
    name: salon.name,
    url,
    ...(salon.description?.trim() ? { description: salon.description.trim() } : {}),
    ...(salon.phone ? { telephone: salon.phone } : {}),
    ...(salon.photos.length
      ? { image: salon.photos.slice(0, 5).map((p) => `${siteUrl()}${p.url}`) }
      : {}),
    address: {
      '@type': 'PostalAddress',
      streetAddress: salon.addressLine,
      addressLocality: salon.city,
      postalCode: salon.postalCode,
    },
    currenciesAccepted: salon.currency,
    // Task 410: the stars clients gave on the platform (1–5), as on the page.
    ...(rating
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: rating.average,
            reviewCount: rating.count,
            bestRating: 5,
            worstRating: 1,
          },
        }
      : {}),
    openingHoursSpecification: salon.openingHours.flatMap((day) =>
      day.intervals.map((i) => ({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: `https://schema.org/${DAYS[day.weekday - 1]}`,
        opens: i.start,
        closes: i.end,
      })),
    ),
    potentialAction: {
      '@type': 'ReserveAction',
      target: { '@type': 'EntryPoint', urlTemplate: url },
    },
    makesOffer: salon.services.slice(0, 50).map((s) => ({
      '@type': 'Offer',
      itemOffered: { '@type': 'Service', name: s.name },
      priceCurrency: salon.currency,
      ...(s.priceFromGrosze === s.priceToGrosze
        ? { price: price(s.priceFromGrosze) }
        : {
            priceSpecification: {
              '@type': 'PriceSpecification',
              minPrice: price(s.priceFromGrosze),
              maxPrice: price(s.priceToGrosze),
              priceCurrency: salon.currency,
            },
          }),
    })),
  };
}

/** JSON for a <script> tag: "<" escaped so that no text from the salon can close the tag. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
