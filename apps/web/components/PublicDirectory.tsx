'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LanguageBadges } from '@/components/Languages';
import { ClientNav } from '@/components/client/ClientNav';
import { ErrorBox, LanguageSwitch, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { rememberedLanguages, rememberLanguages } from '@/lib/catalogue-languages';
import { formatKm, formatRating, locate, type Place } from '@/lib/location';
import { formatPrice } from '@/lib/time';
import {
  SPECIALTIES,
  SPOKEN,
  type PublicSalon,
  type PublicSalonDirectory,
  type Specialty,
  type Spoken,
} from '@/lib/types';

const PAGE_SIZE = 12;
const MAP_WIDTH = 640;
const MAP_HEIGHT = 400;
const TILE_SIZE = 256;
/** Keeps markers away from the edges of the map. */
const MAP_MARGIN = 48;

type Located = PublicSalon & { latitude: number; longitude: number };

const located = (salon: PublicSalon): salon is Located =>
  salon.latitude !== null && salon.longitude !== null;

/** The middle of Poland, shown when no salon of the page has marked its place yet. */
const FALLBACK_CENTER = { latitude: 52.07, longitude: 19.48 } as Located;
const FALLBACK_ZOOM = 6;

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
  const onMap = salons.filter(located);
  // Task 191: without a single salon on the map, the map still shows the country (Poland), not nothing.
  const points: Located[] = onMap.length > 0 ? onMap : [FALLBACK_CENTER];
  let zoom = onMap.length > 0 ? 0 : FALLBACK_ZOOM;
  for (let candidate = 16; onMap.length > 0 && candidate >= 0; candidate -= 1) {
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
    markers:
      onMap.length > 0
        ? projected.map(({ salon, x, y }) => ({ salon, x: x - left, y: y - top }))
        : [],
  };
}

/** Public catalogue: salons open for online booking, filter by spoken language, map. */
export function PublicDirectory() {
  const { t, locale } = useI18n();
  // Task 192: several languages at once - salons speaking any of them; null until the saved choice is read.
  const [languages, setLanguages] = useState<Spoken[] | null>(null);
  const [page, setPage] = useState(1);
  /** Task 160c: the kind of place (what its specialists do), as in the client app. */
  const [specialty, setSpecialty] = useState<Specialty | null>(null);
  // The last numbers stay on the chips while the next page loads.
  const [kindCounts, setKindCounts] = useState<Partial<Record<Specialty, number>>>({});
  const [result, setResult] = useState<PublicSalonDirectory | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [tilesFailed, setTilesFailed] = useState(false);

  // Task 180b: the words searched for; `query` follows the typing after a short pause.
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  // Task 180b: "W pobliżu" - asked only when the client taps it; the nearest salons first.
  const [near, setNear] = useState<Place | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationFailed, setLocationFailed] = useState(false);

  useEffect(() => {
    // The home page's search and kinds of place come in the address (?q=…&specialty=…).
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q')?.trim() ?? '';
    setTyped(q);
    setQuery(q);
    const kind = SPECIALTIES.find((k) => k === params.get('specialty'));
    if (kind) setSpecialty(kind);
    setLanguages(rememberedLanguages());
    // Task 205: "W pobliżu" on the home page - ask for the location straight away.
    if (params.get('near') === '1') void findNear();
  }, []);

  useEffect(() => {
    const next = typed.trim();
    if (next === query) return;
    const timer = setTimeout(() => {
      setQuery(next);
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [typed, query]);

  useEffect(() => {
    if (languages === null) return;
    let active = true;
    setResult(null);
    setError('');
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (languages.length > 0) params.set('language', languages.join(','));
    if (specialty) params.set('specialty', specialty);
    if (query) params.set('q', query);
    if (near) params.set('near', `${near.latitude.toFixed(4)},${near.longitude.toFixed(4)}`);
    api<PublicSalonDirectory>(`/v1/public/locations?${params.toString()}`)
      .then((value) => {
        if (!active) return;
        setResult(value);
        setKindCounts(value.specialtyCounts);
        setSelected((current) => (value.items.some((s) => s.slug === current) ? current : null));
      })
      .catch((err) => {
        if (active) setError(errorText(t, err));
      });
    return () => {
      active = false;
    };
  }, [languages, specialty, query, near, page, t]);

  const toggleNear = async () => {
    if (near) {
      setLocationFailed(false);
      setNear(null);
      setPage(1);
      return;
    }
    await findNear();
  };

  async function findNear() {
    setLocationFailed(false);
    setLocating(true);
    const place = await locate();
    setLocating(false);
    if (place) {
      setNear(place);
      setPage(1);
    } else setLocationFailed(true);
  }

  const choose = (next: Spoken[]) => {
    setLanguages(next);
    rememberLanguages(next);
    setPage(1);
  };
  const chosen = languages ?? [];
  const chooseKind = (next: Specialty | null) => {
    setSpecialty(next);
    setPage(1);
  };
  const kinds = SPECIALTIES.filter((kind) => (kindCounts[kind] ?? 0) > 0 || kind === specialty);
  const toggle = (code: Spoken) =>
    choose(chosen.includes(code) ? chosen.filter((c) => c !== code) : [...chosen, code]);
  const map = result ? mapLayout(result.items) : null;
  const pages = Math.max(1, result?.pageCount ?? 1);

  return (
    <div className="booking directory">
      <ClientNav current="salons" />
      <header className="salon-head">
        <div className="salon-head-inner directory-inner">
          <div className="top" style={{ justifyContent: 'flex-end' }}>
            <LanguageSwitch />
          </div>
          <h1 className="salon-name">{t.directory.title}</h1>
          <p className="muted small">{t.directory.lead}</p>
          <p className="small">{t.clientNav.directoryHint}</p>
          <input
            type="search"
            className="directory-search"
            aria-label={t.directory.search}
            placeholder={t.directory.search}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <div className="chips">
            <button
              type="button"
              aria-pressed={near !== null}
              disabled={locating}
              onClick={() => void toggleNear()}
            >
              {locating ? t.directory.locating : `⌖ ${t.directory.near}`}
            </button>
          </div>
          {locationFailed ? <p className="small muted">{t.directory.locationFailed}</p> : null}
          <div className="chips" role="group" aria-label={t.directory.filterLanguage}>
            <button type="button" aria-pressed={chosen.length === 0} onClick={() => choose([])}>
              {t.directory.allLanguages}
            </button>
            {SPOKEN.map((code) => (
              <button
                key={code}
                type="button"
                aria-pressed={chosen.includes(code)}
                onClick={() => toggle(code)}
              >
                {t.languages.names[code]}
                {result ? ` (${result.languageCounts[code] ?? 0})` : ''}
              </button>
            ))}
            {chosen.length > 0 ? (
              <button className="btn--quiet" type="button" onClick={() => choose([])}>
                {t.directory.clearLanguages}
              </button>
            ) : null}
          </div>
          {kinds.length > 0 ? (
            <div className="chips" role="group" aria-label={t.directory.filterKind}>
              <button
                type="button"
                aria-pressed={specialty === null}
                onClick={() => chooseKind(null)}
              >
                {t.directory.allKinds}
              </button>
              {kinds.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={specialty === kind}
                  onClick={() => chooseKind(kind)}
                >
                  {t.specialties.names[kind]} ({kindCounts[kind] ?? 0})
                </button>
              ))}
            </div>
          ) : null}
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
                      {salon.distanceKm !== null ? (
                        <span className="small muted">
                          {fill(t.directory.distance, {
                            km: formatKm(salon.distanceKm, LOCALE_TAGS[locale]),
                          })}
                        </span>
                      ) : null}
                      {formatRating(salon, LOCALE_TAGS[locale]) ? (
                        <span className="small directory-rating">
                          {fill(t.directory.rating, {
                            rating: formatRating(salon, LOCALE_TAGS[locale])!,
                            n: String(salon.reviewCount),
                          })}
                        </span>
                      ) : null}
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
                        onError={() => setTilesFailed(true)}
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
                    {tilesFailed ? <span role="alert">{t.directory.mapOffline} </span> : null}
                    {map.markers.length === 0 ? <span>{t.directory.mapEmpty} </span> : null}
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
