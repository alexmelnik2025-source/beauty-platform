'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { PublicAppointment, VisitProducts } from '@/lib/types';

/**
 * Task Q3: "Przenieść produkty na nowy termin?" — the visit was cancelled while products waited
 * for it at the salon (they no longer hold pieces). One button opens the booking at the same
 * specialist's times with those products in the link (`?product=…`): they are put aside for the
 * new visit right after booking. Nothing is shown when nothing waited.
 */
export function CancelledVisitProducts({
  endpoint,
  visit,
}: {
  endpoint: string;
  visit: PublicAppointment;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const s = t.visitProducts;
  const [data, setData] = useState<VisitProducts | null>(null);

  useEffect(() => {
    api<VisitProducts>(`${endpoint}/products`, { auth: false })
      .then(setData)
      .catch(() => setData(null));
  }, [endpoint]);

  const waiting = (data?.reservations ?? []).filter(
    (r) => r.status === 'reserved' && r.productId !== null,
  );
  if (!data || waiting.length === 0) return null;
  const query = new URLSearchParams({
    service: visit.service.id,
    staff: visit.staff.id,
    product: Array.from(new Set(waiting.map((r) => r.productId as string))).join(','),
  });

  return (
    <section
      className="section stack"
      aria-labelledby="move-products-title"
      data-testid="move-products"
    >
      <h2 id="move-products-title" className="h3">
        {s.moveTitle}
      </h2>
      <ul className="list" aria-label={s.moveTitle}>
        {waiting.map((r) => (
          <li key={r.id} className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <strong>
              {r.name}
              {r.quantity > 1 ? ` × ${r.quantity}` : ''}
            </strong>
            <span>{formatPrice(r.totalGrosze, data.currency, tag)}</span>
          </li>
        ))}
      </ul>
      <p className="small muted">{s.moveLead}</p>
      <Link
        className="btn btn--block"
        href={`/${locale}/b/${visit.salon.slug}?${query.toString()}`}
      >
        {s.moveBook}
      </Link>
    </section>
  );
}
