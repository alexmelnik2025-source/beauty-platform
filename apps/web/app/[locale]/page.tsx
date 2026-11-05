'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ClientNav } from '@/components/client/ClientNav';
import { SearchForm } from '@/components/client/SearchForm';
import { LanguageSwitch } from '@/components/ui';
import { api } from '@/lib/api';
import { catalogueHref, EMPTY_SEARCH } from '@/lib/catalogue-search';
import { fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { PublicSalonDirectory, Specialty } from '@/lib/types';

/** Task 180b: the categories of the home page, as the owner listed them. */
const CATEGORIES: Specialty[] = [
  'barber',
  'hairdresser',
  'nails',
  'brows_lashes',
  'cosmetologist',
  'massage',
];

/**
 * Home page for clients (task 180; 180b — "as in Fresha", owner's decision 05.11): a large search
 * "Czego szukasz?" / "Gdzie?" / "W pobliżu", categories, salons with online booking, "Moje wizyty".
 * Nothing needs signing in; the account is made by the first booking. The salon dashboard is a
 * link at the bottom ("Dla salonów").
 */
export default function Home() {
  const { t, locale } = useI18n();
  const n = t.clientNav;
  const [featured, setFeatured] = useState<PublicSalonDirectory['items'] | null>(null);

  useEffect(() => {
    let alive = true;
    api<PublicSalonDirectory>('/v1/public/locations?page=1&pageSize=6', { auth: false })
      .then((value) => alive && setFeatured(value.items))
      .catch(() => alive && setFeatured([]));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="booking">
      <ClientNav />
      <main className="narrow client-home">
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <LanguageSwitch />
        </div>
        <h1>{n.searchTitle}</h1>
        <p className="muted">{n.homeLead}</p>
        <SearchForm initial={EMPTY_SEARCH} large />
        <nav className="client-categories" aria-label={n.categories}>
          {CATEGORIES.map((kind) => (
            <Link key={kind} href={catalogueHref(locale, { ...EMPTY_SEARCH, specialty: kind })}>
              {t.specialties.names[kind]}
            </Link>
          ))}
        </nav>

        {featured && featured.length > 0 ? (
          <section className="stack" aria-labelledby="featured-title">
            <h2 id="featured-title">{n.featured}</h2>
            <ul className="client-featured">
              {featured.map((salon) => (
                <li key={salon.slug}>
                  <Link href={`/${locale}/b/${salon.slug}`} className="client-featured-card">
                    {salon.photoUrl ? (
                      <img src={salon.photoUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="client-featured-initial" aria-hidden="true">
                        {salon.name.slice(0, 1)}
                      </span>
                    )}
                    <strong>{salon.name}</strong>
                    <span className="small muted">{salon.city}</span>
                    {salon.priceFromGrosze !== null ? (
                      <span className="small">
                        {fill(t.directory.priceFrom, {
                          price: formatPrice(
                            salon.priceFromGrosze,
                            salon.currency,
                            LOCALE_TAGS[locale],
                          ),
                        })}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
            <Link href={`/${locale}/salons`}>{n.seeAll} →</Link>
          </section>
        ) : null}

        <Link className="client-home-choice" href={`/${locale}/c`}>
          <strong>{n.myVisits}</strong>
          <span className="small muted">{n.myVisitsHint}</span>
          <span className="small muted">{n.accountHint}</span>
        </Link>
        <div className="client-home-salons small">
          <Link href={`/${locale}/login`}>{n.forSalons}</Link>
          <span className="muted"> — {n.forSalonsHint}</span>
        </div>
      </main>
    </div>
  );
}
