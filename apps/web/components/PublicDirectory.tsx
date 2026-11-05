'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LanguageBadges } from '@/components/Languages';
import { ErrorBox, LanguageSwitch, Spinner, Wordmark } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import { SPOKEN, type PublicSalon, type PublicSalonDirectory, type Spoken } from '@/lib/types';

const PAGE_SIZE = 12;
const MAP_WIDTH = 640;
const MAP_HEIGHT = 400;
const TILE_SIZE = 256;
/** Keeps markers away from the edges of the map. */
const MAP_MARGIN = 48;

type Located = PublicSalon & { latitude: number; longitude: number };

const located = (salon: PublicSalon): salon is Located =>
  salon.latitude !== null && salon.longitude !== null;

/** Web Mercator, the projection of OpenStreetMap tiles, in pixels at `zoom`. */
function project(salon: Located, zoom: number): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** zoom;
  const lat = (Math.max(-85.0511, Math.min(85.0511, salon.latitude)) * Math.PI) / 180;
  return {
    x: ((salon.longitude + 180) / 360) * scale,
    y: ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * scale,
  };
}

/** The closest zoom (at most street level) that shows every salon of the page, and its tiles. */
function mapLayout(salons: PublicSalon[]) {
  const points = salons.filter(located);
  if (points.length === 0) return null;
  let zoom = 0;
  for (let candidate = 16; candidate >= 0; candidate -= 1) {
    const projected = points.map((salon) => project(salon, candidate));
    const xs = projected.map((p) => p.x);
    const ys = projected.map((p) => p.y);
    if (
      Math.max(...xs) - Math.min(...xs) <= MAP_WIDTH - 2 * MAP_MARGIN &&
      Math.max(...ys) - Math.min(...ys) <= MAP_HEIGHT - 2 * MAP_MARGIN
    ) {
      zoom = candidate;
      break;
    }
  }
  const projected = points.map((salon) => ({ salon, ...project(salon, zoom) }));
  const xs = projected.map((p) => p.x);
  const ys = projected.map((p) => p.y);
  const left = (Math.min(...xs) + Math.max(...xs)) / 2 - MAP_WIDTH / 2;
  const top = (Math.min(...ys) + Math.max(...ys)) / 2 - MAP_HEIGHT / 2;
  const world = 2 ** zoom;
  const tiles: { key: string; x: number; y: number; url: string }[] = [];
  for (let x = Math.floor(left / TILE_SIZE); x <= Math.floor((left + MAP_WIDTH) / TILE_SIZE); x++) {
    for (
      let y = Math.floor(top / TILE_SIZE);
      y <= Math.floor((top + MAP_HEIGHT) / TILE_SIZE);
      y++
    ) {
      if (y < 0 || y >= world) continue;
      const wrapped = ((x % world) + world) % world;
      tiles.push({
        key: `${zoom}/${x}/${y}`,
        x: x * TILE_SIZE - left,
        y: y * TILE_SIZE - top,
        url: `https://tile.openstreetmap.org/${zoom}/${wrapped}/${y}.png`,
      });
    }
  }
  return {
    tiles,
    markers: projected.map(({ salon, x, y }) => ({ salon, x: x - left, y: y - top })),
  };
}

/** Public catalogue: salons open for online booking, filter by spoken language, map. */
export function PublicDirectory() {
  const { t, locale } = useI18n();
  const [language, setLanguage] = useState<Spoken | null>(null);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PublicSalonDirectory | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setResult(null);
    setError('');
    const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (language) query.set('language', language);
    api<PublicSalonDirectory>(`/v1/public/locations?${query.toString()}`)
      .then((value) => {
        if (!active) return;
        setResult(value);
        setSelected((current) => (value.items.some((s) => s.slug === current) ? current : null));
      })
      .catch((err) => {
        if (active) setError(errorText(t, err));
      });
    return () => {
      active = false;
    };
  }, [language, page, t]);

  const choose = (next: Spoken | null) => {
    setLanguage(next);
    setPage(1);
  };
  const map = result ? mapLayout(result.items) : null;
  const pages = Math.max(1, result?.pageCount ?? 1);

  return (
    <div className="booking directory">
      <header className="salon-head">
        <div className="salon-head-inner directory-inner">
          <div className="top">
            <Wordmark />
            <LanguageSwitch />
          </div>
          <h1 className="salon-name">{t.directory.title}</h1>
          <p className="muted small">{t.directory.lead}</p>
          <div className="chips" role="group" aria-label={t.directory.filterLanguage}>
            <button type="button" aria-pressed={language === null} onClick={() => choose(null)}>
              {t.directory.allLanguages}
            </button>
            {SPOKEN.map((code) => (
              <button
                key={code}
                type="button"
                aria-pressed={language === code}
                onClick={() => choose(code)}
              >
                {t.languages.names[code]}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="directory-inner stack">
        <ErrorBox>{error}</ErrorBox>
        {!result && !error ? <Spinner /> : null}
        {result ? (
          <>
            <p className="small muted" aria-live="polite">
              {fill(t.directory.found, { n: String(result.total) })}
            </p>
            <div className="directory-grid">
              <ul className="list directory-list">
                {result.items.length === 0 ? <li className="muted">{t.directory.empty}</li> : null}
                {result.items.map((salon) => (
                  <li key={salon.slug} data-selected={salon.slug === selected || undefined}>
                    <article className="stack directory-salon" aria-label={salon.name}>
                      <h2>
                        <Link href={`/${locale}/b/${salon.slug}`}>{salon.name}</Link>
                      </h2>
                      <span className="muted small">
                        {salon.addressLine}, {salon.postalCode} {salon.city}
                      </span>
                      {salon.priceFromGrosze !== null ? (
                        <span className="small directory-price">
                          {fill(t.directory.priceFrom, {
                            price: formatPrice(
                              salon.priceFromGrosze,
                              salon.currency,
                              LOCALE_TAGS[locale],
                            ),
                          })}
                        </span>
                      ) : null}
                      <LanguageBadges codes={salon.languages} label={t.languages.speaks} />
                      <div className="row">
                        <Link className="btn" href={`/${locale}/b/${salon.slug}`}>
                          {t.directory.book}
                        </Link>
                        {located(salon) ? (
                          <button
                            className="btn btn--quiet"
                            type="button"
                            aria-pressed={salon.slug === selected}
                            onClick={() => setSelected(salon.slug)}
                          >
                            {t.directory.showMap}
                          </button>
                        ) : (
                          <span className="small muted">{t.directory.noCoordinates}</span>
                        )}
                      </div>
                    </article>
                  </li>
                ))}
              </ul>
              {map ? (
                <figure className="directory-map">
                  <svg
                    role="img"
                    aria-label={t.directory.mapTitle}
                    viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
                  >
                    <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="#e8e4dc" />
                    {map.tiles.map((tile) => (
                      <image
                        key={tile.key}
                        href={tile.url}
                        x={tile.x}
                        y={tile.y}
                        width={TILE_SIZE}
                        height={TILE_SIZE}
                      />
                    ))}
                    {map.markers.map(({ salon, x, y }) => {
                      const on = salon.slug === selected;
                      return (
                        <a key={salon.slug} href={`/${locale}/b/${salon.slug}`}>
                          <title>{salon.name}</title>
                          <circle
                            className="directory-marker"
                            cx={x}
                            cy={y}
                            r={on ? 11 : 8}
                            fill={on ? '#111' : '#c72d43'}
                            stroke="#fff"
                            strokeWidth="3"
                          />
                        </a>
                      );
                    })}
                  </svg>
                  <figcaption className="small muted">
                    <a
                      href="https://www.openstreetmap.org/copyright"
                      target="_blank"
                      rel="noreferrer"
                    >
                      © OpenStreetMap
                    </a>
                  </figcaption>
                </figure>
              ) : null}
            </div>
            {pages > 1 ? (
              <nav className="row directory-pages" aria-label={t.directory.title}>
                <button
                  className="btn btn--quiet"
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  {t.directory.previous}
                </button>
                <span className="small muted">
                  {fill(t.directory.page, { page: String(page), pages: String(pages) })}
                </span>
                <button
                  className="btn btn--quiet"
                  type="button"
                  disabled={page >= pages}
                  onClick={() => setPage(page + 1)}
                >
                  {t.directory.next}
                </button>
              </nav>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
