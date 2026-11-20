'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { PublicSalonProducts } from '@/lib/types';

/**
 * Task Q3 (part 3): "Produkty salonu" on the booking page — what the salon sells to its clients,
 * to pick up and pay for at a visit. One folded row under the services (nothing when the salon
 * shows no products), so it never stands between the client and the booking; opened, a short list
 * with the picture, name, brand and price. Putting a product aside for a visit comes with the
 * next parts (A/B/C); at the launch there is no online payment and no shipping.
 */
export function SalonProducts({ slug }: { slug: string }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PublicSalonProducts | null>(null);

  useEffect(() => {
    api<PublicSalonProducts>(`/v1/public/locations/${encodeURIComponent(slug)}/products`, {
      auth: false,
    })
      .then(setData)
      .catch(() => setData(null));
  }, [slug]);

  if (!data || data.products.length === 0) return null;
  const s = t.salonProducts;

  return (
    <section className="salon-products" data-testid="salon-products">
      <button
        type="button"
        className="btn btn--quiet btn--small"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {fill(s.open, { n: String(data.products.length) })}
      </button>
      {open ? (
        <div className="stack" style={{ marginTop: 8 }}>
          <p className="small muted">{s.pickup}</p>
          <ul className="list" aria-label={s.title}>
            {data.products.map((p) => (
              <li key={p.id} className="row" style={{ alignItems: 'center', gap: 12 }}>
                {p.photoId ? (
                  <img
                    src={`/v1/public/photos/${p.photoId}`}
                    alt=""
                    width={56}
                    height={56}
                    loading="lazy"
                    style={{ objectFit: 'cover', borderRadius: 8, flex: 'none' }}
                  />
                ) : null}
                <span className="stack" style={{ gap: 2, flex: 1 }}>
                  <span>
                    <strong>{p.name}</strong>
                    {p.brand ? <span className="muted"> · {p.brand}</span> : null}
                  </span>
                  {!p.available ? <span className="small muted">{s.unavailable}</span> : null}
                </span>
                <span>{formatPrice(p.priceGrosze, data.currency, tag)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
