'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { PublicSalonProducts } from '@/lib/types';

/**
 * Audit EJ fix (28.11.2026): "Umów kolejną wizytę" after "Odłóż na następną wizytę" — the client
 * sees in the booking form, before confirming, which products wait for this visit ("Odłożymy na tę
 * wizytę: Pomada, 59,00 zł"). Names and prices come from the salon's public products; a product
 * the salon no longer shows is left out. Nothing when nothing was chosen.
 */
export function BringingProducts({ slug, ids }: { slug: string; ids: string[] }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<PublicSalonProducts | null>(null);
  const wanted = ids.length > 0;

  useEffect(() => {
    if (!wanted) return;
    api<PublicSalonProducts>(`/v1/public/locations/${encodeURIComponent(slug)}/products`, {
      auth: false,
    })
      .then(setData)
      .catch(() => setData(null));
  }, [slug, wanted]);

  if (!data) return null;
  const items = data.products
    .filter((p) => ids.includes(p.id))
    .map((p) => `${p.name}, ${formatPrice(p.priceGrosze, data.currency, LOCALE_TAGS[locale])}`);
  if (items.length === 0) return null;
  return (
    <p className="note small" data-testid="booking-bringing">
      🛍️ {fill(t.visitProducts.bringing, { items: items.join('; ') })}{' '}
      <span className="muted">{t.visitProducts.payAtPickup}</span>
    </p>
  );
}
