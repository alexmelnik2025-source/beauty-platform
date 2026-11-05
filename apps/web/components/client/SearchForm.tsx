'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useI18n } from '@/lib/i18n';
import { catalogueHref, whereAmI, type CatalogueSearch } from '@/lib/catalogue-search';

/**
 * Task 180b (owner's decision 05.11, "as in Fresha"): "Czego szukasz?" + "Gdzie?" and "W pobliżu"
 * on the home page and above the catalogue. It opens the catalogue with the search in its address.
 */
export function SearchForm({ initial, large }: { initial: CatalogueSearch; large?: boolean }) {
  const { t, locale } = useI18n();
  const n = t.clientNav;
  const router = useRouter();
  const [q, setQ] = useState(initial.q);
  const [city, setCity] = useState(initial.city);
  const [locating, setLocating] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // A typed city replaces "W pobliżu".
    router.push(
      catalogueHref(locale, {
        ...initial,
        q,
        city,
        near: city.trim() ? null : initial.near,
      }),
    );
  };

  const nearMe = async () => {
    setLocating(true);
    setFailed(false);
    const near = await whereAmI();
    setLocating(false);
    if (!near) {
      setFailed(true);
      return;
    }
    setCity('');
    router.push(catalogueHref(locale, { ...initial, q, city: '', near }));
  };

  return (
    <form
      className={`client-search${large ? ' client-search--large' : ''}`}
      role="search"
      aria-label={n.searchTitle}
      onSubmit={submit}
    >
      <label className="client-search-field">
        <span className="small">{n.searchWhat}</span>
        <input
          type="search"
          name="q"
          value={q}
          maxLength={80}
          placeholder={n.searchWhatPlaceholder}
          onChange={(event) => setQ(event.target.value)}
        />
      </label>
      <label className="client-search-field">
        <span className="small">{n.searchWhere}</span>
        <input
          type="text"
          name="city"
          value={city}
          maxLength={80}
          placeholder={initial.near && !city ? n.nearby : n.searchWherePlaceholder}
          onChange={(event) => setCity(event.target.value)}
        />
      </label>
      <div className="client-search-actions">
        <button className="btn" type="submit">
          {n.search}
        </button>
        <button
          className="btn btn--quiet"
          type="button"
          aria-pressed={initial.near !== null && !city}
          disabled={locating}
          onClick={() => void nearMe()}
        >
          ⌖ {n.nearMe}
        </button>
      </div>
      {failed ? (
        <p className="small" role="alert">
          {n.nearMeFailed}
        </p>
      ) : null}
    </form>
  );
}
