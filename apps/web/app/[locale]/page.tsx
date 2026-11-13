'use client';

import Link from 'next/link';
import { OpenNow } from '@/components/OpenNow';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ClientNav } from '@/components/client/ClientNav';
import { LanguageSwitch } from '@/components/ui';
import { api } from '@/lib/api';
import { fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatRating } from '@/lib/location';
import { formatPrice } from '@/lib/time';
import type { PublicSalonDirectory, Specialty } from '@/lib/types';

/** Task 180b: the kinds of place on the home page, the most asked for first. */
const CATEGORIES: Specialty[] = [
  'barber',
  'hairdresser',
  'nails',
  'brows_lashes',
  'cosmetologist',
  'massage',
];

/**
 * Home page for clients (tasks 180, 180b — "as on Fresha"): a big search "Czego szukasz?" and
 * "Gdzie?", the kinds of place, recommended salons; "Moje wizyty" and the salon dashboard
 * ("Dla salonów") below. Signing in is never needed to look around.
 */
export default function Home() {
  const { t, locale } = useI18n();
  const n = t.clientNav;
  const router = useRouter();
  const [what, setWhat] = useState('');
  const [where, setWhere] = useState('');
  const [featured, setFeatured] = useState<PublicSalonDirectory['items']>([]);
  // Task 369: how many salons are open right now (today's real hours), for the link below.
  const [openNowCount, setOpenNowCount] = useState(0);

  useEffect(() => {
    let live = true;
    api<PublicSalonDirectory>('/v1/public/locations?page=1&pageSize=6', { auth: false })
      .then((res) => {
        if (live) {
          setFeatured(res.items);
          setOpenNowCount(res.openNowCount);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  function search(e: FormEvent) {
    e.preventDefault();
    const q = `${what} ${where}`.trim();
    router.push(`/${locale}/salons${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  }

  return (
    <div className="booking">
      <ClientNav />
      <main className="narrow client-home">
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <LanguageSwitch />
        </div>
        <h1>{n.homeTitle}</h1>
        <p className="muted">{n.homeLead}</p>
        <form className="home-search" role="search" onSubmit={search}>
          <label className="field">
            <span>{n.searchWhat}</span>
            <input
              value={what}
              placeholder={n.searchWhatPlaceholder}
              onChange={(e) => setWhat(e.target.value)}
            />
          </label>
          <label className="field">
            <span>{n.searchWhere}</span>
            <input
              value={where}
              placeholder={n.searchWherePlaceholder}
              autoComplete="address-level2"
              onChange={(e) => setWhere(e.target.value)}
            />
          </label>
          <button className="btn btn--block">{n.searchButton}</button>
        </form>
        {/* Task 205: the catalogue opens with the nearest salons (it asks for the location). */}
        <Link className="btn btn--quiet btn--block" href={`/${locale}/salons?near=1`}>
          ⌖ {t.directory.near}
        </Link>
        {/* Task 369: straight to the salons open right now; not shown when none is open. */}
        {openNowCount > 0 ? (
          <Link
            className="btn btn--quiet btn--block home-open-now"
            href={`/${locale}/salons?openNow=1`}
          >
            <span className="open-status" data-open="true">
              {t.directory.openNow} ({openNowCount})
            </span>
          </Link>
        ) : null}
        {/* Task 379: the catalogue with the best rated salons first. */}
        <Link className="btn btn--quiet btn--block" href={`/${locale}/salons?sort=rating`}>
          {t.directory.bestRated}
        </Link>
        <section className="stack" aria-labelledby="home-categories">
          <h2 id="home-categories" className="small muted">
            {n.categories}
          </h2>
          <div className="home-categories">
            {CATEGORIES.map((kind) => (
              <Link key={kind} href={`/${locale}/salons?specialty=${kind}`}>
                {t.specialties.names[kind]}
              </Link>
            ))}
          </div>
        </section>
        <Link className="client-home-choice client-home-choice--main" href={`/${locale}/salons`}>
          <strong>{n.findSalon}</strong>
          <span className="small muted">{n.findSalonHint}</span>
        </Link>
        {featured.length > 0 ? (
          <section className="stack" aria-labelledby="home-featured">
            <h2 id="home-featured">{n.featured}</h2>
            <ul className="home-featured">
              {featured.map((salon) => (
                <li key={salon.slug}>
                  <Link href={`/${locale}/b/${salon.slug}`} aria-label={salon.name}>
                    {salon.photoUrl ? <img src={salon.photoUrl} alt="" decoding="async" /> : null}
                    <strong>{salon.name}</strong>
                    <span className="small muted">
                      {salon.addressLine}, {salon.city}
                    </span>
                    <OpenNow salon={salon} />
                    {formatRating(salon, LOCALE_TAGS[locale]) ? (
                      <span className="small directory-rating">
                        {fill(t.directory.rating, {
                          rating: formatRating(salon, LOCALE_TAGS[locale])!,
                          n: String(salon.reviewCount),
                        })}
                      </span>
                    ) : null}
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
          </section>
        ) : null}
        <Link className="client-home-choice" href={`/${locale}/c`}>
          <strong>{n.myVisits}</strong>
          <span className="small muted">
            {n.myVisitsHint} {n.signInLater}
          </span>
        </Link>
        <div className="client-home-salons small">
          <Link href={`/${locale}/login`}>{n.forSalons}</Link>
          <span className="muted"> — {n.forSalonsHint}</span>
        </div>
      </main>
    </div>
  );
}
