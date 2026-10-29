'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ErrorBox, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';

type SpokenLanguage = 'pl' | 'uk' | 'ru' | 'be' | 'en';
interface PublicSalon {
  slug: string;
  name: string;
  addressLine: string;
  city: string;
  postalCode: string;
  languages: SpokenLanguage[];
  latitude: number | null;
  longitude: number | null;
}
interface DirectoryResult {
  items: PublicSalon[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

const LANGUAGES: SpokenLanguage[] = ['pl', 'uk', 'ru', 'be', 'en'];
const MAP_WIDTH = 640;
const MAP_HEIGHT = 400;
const TILE_SIZE = 256;

function project(salon: PublicSalon, zoom: number) {
  const scale = TILE_SIZE * 2 ** zoom;
  const lat = Math.max(-85.0511, Math.min(85.0511, salon.latitude ?? 0)) * (Math.PI / 180);
  return {
    x: ((salon.longitude! + 180) / 360) * scale,
    y: ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * scale,
  };
}

function mapLayout(salons: PublicSalon[]) {
  const located = salons.filter((salon) => salon.latitude !== null && salon.longitude !== null);
  if (located.length === 0) return null;
  let zoom = 0;
  let points = located.map((salon) => project(salon, zoom));
  for (let candidate = 16; candidate >= 0; candidate -= 1) {
    const projected = located.map((salon) => project(salon, candidate));
    const spanX =
      Math.max(...projected.map((point) => point.x)) -
      Math.min(...projected.map((point) => point.x));
    const spanY =
      Math.max(...projected.map((point) => point.y)) -
      Math.min(...projected.map((point) => point.y));
    if (spanX <= MAP_WIDTH - 96 && spanY <= MAP_HEIGHT - 96) {
      zoom = candidate;
      points = projected;
      break;
    }
  }
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const left = (minX + maxX) / 2 - MAP_WIDTH / 2;
  const top = (minY + maxY) / 2 - MAP_HEIGHT / 2;
  const firstTileX = Math.floor(left / TILE_SIZE);
  const lastTileX = Math.floor((left + MAP_WIDTH) / TILE_SIZE);
  const firstTileY = Math.floor(top / TILE_SIZE);
  const lastTileY = Math.floor((top + MAP_HEIGHT) / TILE_SIZE);
  const tiles = [];
  for (let x = firstTileX; x <= lastTileX; x += 1) {
    for (let y = firstTileY; y <= lastTileY; y += 1) {
      const worldSize = 2 ** zoom;
      if (y < 0 || y >= worldSize) continue;
      const wrappedX = ((x % worldSize) + worldSize) % worldSize;
      tiles.push({
        key: `${zoom}/${wrappedX}/${y}`,
        x: x * TILE_SIZE - left,
        y: y * TILE_SIZE - top,
        url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${y}.png`,
      });
    }
  }
  return {
    left,
    top,
    points: located.map((salon) => ({ salon, ...project(salon, zoom) })),
    tiles,
  };
}

export function PublicDirectory() {
  const { t, locale } = useI18n();
  const [language, setLanguage] = useState<SpokenLanguage | ''>('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<DirectoryResult | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setResult(null);
    setError('');
    const query = new URLSearchParams({ page: String(page), pageSize: '12' });
    if (language) query.set('language', language);
    api<DirectoryResult>(`/v1/public/locations?${query.toString()}`)
      .then((value) => {
        if (!active) return;
        setResult(value);
        setSelected((current) =>
          value.items.some((item) => item.slug === current) ? current : null,
        );
      })
      .catch((err) => {
        if (active) setError(errorText(t, err));
      });
    return () => {
      active = false;
    };
  }, [language, page, t]);

  const selectedSalon = result?.items.find((item) => item.slug === selected) ?? null;
  const map = result ? mapLayout(result.items) : null;
  const pages = result?.pageCount ?? 0;

  return (
    <main className="page" style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 16px' }}>
      <div className="page-head">
        <h1>{t.directory.title}</h1>
      </div>
      <label className="field" style={{ maxWidth: 360, marginBottom: 20 }}>
        <span>{t.directory.filterLanguage}</span>
        <select
          value={language}
          onChange={(event) => {
            setLanguage(event.target.value as SpokenLanguage | '');
            setPage(1);
          }}
        >
          <option value="">{t.directory.allLanguages}</option>
          {LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {t.directory.languages[code]}
            </option>
          ))}
        </select>
      </label>

      <ErrorBox>{error}</ErrorBox>
      {!result && !error ? <Spinner /> : null}
      {result ? (
        <>
          <p className="small muted" aria-live="polite">
            {result.total} {t.directory.salons}
          </p>
          <div
            className="stack"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 20,
              alignItems: 'start',
            }}
          >
            <div className="stack" style={{ gap: 12 }}>
              {result.items.length === 0 ? <p>{t.directory.empty}</p> : null}
              {result.items.map((salon) => (
                <article className="section" key={salon.slug}>
                  <h2>
                    <Link href={`/${locale}/b/${salon.slug}`}>{salon.name}</Link>
                  </h2>
                  <p>{salon.addressLine}</p>
                  <p>
                    {salon.postalCode} {salon.city}
                  </p>
                  <p className="small muted">
                    {salon.languages.map((code) => t.directory.languages[code]).join(', ')}
                  </p>
                  <button
                    className="btn btn--quiet"
                    type="button"
                    onClick={() => setSelected(salon.slug)}
                    disabled={salon.latitude === null || salon.longitude === null}
                  >
                    {salon.latitude === null || salon.longitude === null
                      ? t.directory.noCoordinates
                      : t.directory.showMap}
                  </button>
                </article>
              ))}
            </div>
            <section className="section" aria-label={t.directory.mapTitle}>
              <h2>{t.directory.mapTitle}</h2>
              {map ? (
                <svg
                  role="img"
                  aria-label={t.directory.mapTitle}
                  viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
                  style={{ width: '100%', height: 'auto', display: 'block' }}
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
                  {map.points.map(({ salon, x, y }) => (
                    <g key={salon.slug}>
                      <title>{salon.name}</title>
                      <circle
                        cx={x - map.left}
                        cy={y - map.top}
                        r={salon.slug === selectedSalon?.slug ? 10 : 7}
                        fill={salon.slug === selectedSalon?.slug ? '#111' : '#c72d43'}
                        stroke="#fff"
                        strokeWidth="3"
                      />
                    </g>
                  ))}
                </svg>
              ) : (
                <p className="small muted">{t.directory.noCoordinates}</p>
              )}
              <p className="small muted">
                <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
                  © OpenStreetMap contributors
                </a>
              </p>
            </section>
          </div>
          <nav
            className="row"
            aria-label={t.directory.title}
            style={{ marginTop: 20, alignItems: 'center' }}
          >
            <button
              className="btn btn--quiet"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              {t.directory.previous}
            </button>
            <span className="small muted">
              {t.directory.page
                .replace('{page}', String(page))
                .replace('{pages}', String(Math.max(1, pages)))}
            </span>
            <button
              className="btn btn--quiet"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              {t.directory.next}
            </button>
          </nav>
        </>
      ) : null}
    </main>
  );
}
