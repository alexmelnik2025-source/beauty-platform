'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';
import type { Product, ProductList } from '@/lib/types';
import { useSession } from '../Session';
import { ErrorBox } from '../ui';
import { parseTip as parseAmount } from '../calendar/TipField';

/** 4500 → "45", 4550 → "45,50" — for the price field. */
function amountInput(hundredths: number): string {
  const whole = Math.floor(hundredths / 100);
  const cents = hundredths % 100;
  return cents === 0 ? String(whole) : `${whole},${String(cents).padStart(2, '0')}`;
}

/**
 * Task 395: "Produkty" in "Usługi" — the salon's own list of products sold at a visit (pomade,
 * shampoo…): add, change the name or price, "Nie sprzedajemy", remove. Past sales keep the
 * name and price they had. Owners and managers (the page is theirs).
 */
export function ProductsSection({ base }: { base: string }) {
  const { t } = useI18n();
  const p = t.products;
  const { location } = useSession();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { name: string; price: string }>>({});
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const show = (list: Product[]) => {
    setProducts(list);
    setDrafts(
      Object.fromEntries(
        list.map((x) => [x.id, { name: x.name, price: amountInput(x.priceGrosze) }]),
      ),
    );
  };

  const load = useCallback(async () => {
    try {
      show((await api<ProductList>(`${base}/products`)).products);
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [base, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
      return true;
    } catch (err) {
      setError(errorText(t, err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const newPrice = parseAmount(price);
  const canAdd = name.trim() !== '' && price.trim() !== '' && newPrice !== null && !busy;

  return (
    <section className="page section" data-testid="products">
      <h2>{p.title}</h2>
      <p className="small muted">{p.hint}</p>
      <ErrorBox>{error}</ErrorBox>
      {products && products.length === 0 ? <p className="note">{p.empty}</p> : null}
      {products && products.length > 0 ? (
        <ul className="commission-list">
          {products.map((x) => {
            const draft = drafts[x.id] ?? { name: x.name, price: amountInput(x.priceGrosze) };
            const draftPrice = parseAmount(draft.price);
            const changed =
              draft.name.trim() !== x.name || (draftPrice !== null && draftPrice !== x.priceGrosze);
            return (
              <li key={x.id} className="commission-row" data-testid="product-row">
                <input
                  aria-label={`${p.name} — ${x.name}`}
                  value={draft.name}
                  maxLength={80}
                  onChange={(e) =>
                    setDrafts({ ...drafts, [x.id]: { ...draft, name: e.target.value } })
                  }
                  style={{ flex: '1 1 12rem' }}
                />
                <span className="commission-row__input">
                  <input
                    inputMode="decimal"
                    aria-label={`${p.price} — ${x.name}`}
                    aria-invalid={draftPrice === null}
                    value={draft.price}
                    onChange={(e) =>
                      setDrafts({ ...drafts, [x.id]: { ...draft, price: e.target.value } })
                    }
                  />
                  <span aria-hidden="true">{location.currency}</span>
                </span>
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={busy || !changed || draftPrice === null || draft.name.trim() === ''}
                  onClick={() =>
                    void run(() =>
                      api(`${base}/products/${x.id}`, {
                        method: 'PATCH',
                        body: { name: draft.name.trim(), priceGrosze: draftPrice },
                      }),
                    )
                  }
                >
                  {p.save}
                </button>
                <label className="check small">
                  <input
                    type="checkbox"
                    checked={x.active}
                    disabled={busy}
                    onChange={(e) =>
                      void run(() =>
                        api(`${base}/products/${x.id}`, {
                          method: 'PATCH',
                          body: { active: e.target.checked },
                        }),
                      )
                    }
                  />
                  <span>{p.active}</span>
                </label>
                <button
                  type="button"
                  className="link-btn small"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(p.removeAsk.replace('{name}', x.name))) {
                      void run(() => api(`${base}/products/${x.id}`, { method: 'DELETE' }));
                    }
                  }}
                >
                  {p.remove}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <form
        className="row"
        style={{ alignItems: 'end' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canAdd) return;
          void run(() =>
            api(`${base}/products`, {
              method: 'POST',
              body: { name: name.trim(), priceGrosze: newPrice },
            }),
          ).then((ok) => {
            if (ok) {
              setName('');
              setPrice('');
            }
          });
        }}
      >
        <label className="field">
          <span>{p.newName}</span>
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>
            {p.price} ({location.currency})
          </span>
          <input
            inputMode="decimal"
            value={price}
            aria-invalid={price !== '' && newPrice === null}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn--small" disabled={!canAdd}>
          + {p.add}
        </button>
      </form>
    </section>
  );
}
