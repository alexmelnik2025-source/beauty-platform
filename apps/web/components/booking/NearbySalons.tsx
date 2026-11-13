'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { OpenNow } from '@/components/OpenNow';
import { api } from '@/lib/api';
import { fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatKm, formatRating } from '@/lib/location';
import { formatPrice } from '@/lib/time';
import type { PublicSalonDirectory } from '@/lib/types';

/** Neighbours farther than this are not "nearby": the section shows only the closer ones. */
export const NEARBY_KM = 30;
const NEARBY_COUNT = 3;

/**
 * Task 400: "Inne salony w pobliżu" at the end of a salon page — up to three salons of the
 * catalogue nearest to this one (within 30 km), with the distance from it, "Otwarte teraz", the
 * stars and the lowest price. Nothing while the salon has no place on the map or no neighbours.
 */
export function NearbySalons({ slug }: { slug: string }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [salons, setSalons] = useState<PublicSalonDirectory['items']>([]);

  useEffect(() => {
    let live = true;
    api<PublicSalonDirectory>('/v1/public/locations', {
      auth: false,
      query: { nearSalon: slug, pageSize: NEARBY_COUNT },
    })
      .then((res) => {
        if (!live) return;
        setSalons(
          res.items.filter((salon) => salon.distanceKm !== null && salon.distanceKm <= NEARBY_KM),
        );
      })
      .catch(() => live && setSalons([]));
    return () => {
      live = false;
    };
  }, [slug]);

  if (salons.length === 0) return null;
  return (
    <section className="stack nearby-salons" aria-labelledby="nearby-salons-title">
      <h2 id="nearby-salons-title">{t.booking.nearbyTitle}</h2>
      <ul className="list">
        {salons.map((salon) => (
          <li key={salon.slug}>
            <article className="stack directory-salon" aria-label={salon.name}>
              <h3>
                <Link href={`/${locale}/b/${salon.slug}`}>{salon.name}</Link>
              </h3>
              <span className="muted small">
                {salon.addressLine}, {salon.city}
              </span>
              <span className="small muted">
                {fill(t.booking.nearbyDistance, { km: formatKm(salon.distanceKm ?? 0, tag) })}
              </span>
              <OpenNow salon={salon} />
              {formatRating(salon, tag) ? (
                <span className="small directory-rating">
                  {fill(t.directory.rating, {
                    rating: formatRating(salon, tag)!,
                    n: String(salon.reviewCount),
                  })}
                </span>
              ) : null}
              {salon.priceFromGrosze !== null ? (
                <span className="small directory-price">
                  {fill(t.directory.priceFrom, {
                    price: formatPrice(salon.priceFromGrosze, salon.currency, tag),
                  })}
                </span>
              ) : null}
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
