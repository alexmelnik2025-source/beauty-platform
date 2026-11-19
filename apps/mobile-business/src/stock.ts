/**
 * Task 431: the "W magazynie" field of a product — "" → null (the salon does not count the
 * pieces), "12" → 12; anything else (letters, a negative or a too big number) → undefined.
 */
export function parseStock(value: string): number | null | undefined {
  const text = value.trim();
  if (text === '') return null;
  return /^\d{1,6}$/.test(text) && Number(text) <= 100_000 ? Number(text) : undefined;
}

/** Task 477: the pieces that came in a delivery — "" → null (nothing came), "12" → 12; 0 or anything else → undefined. */
export function parseDelivery(value: string): number | null | undefined {
  const n = parseStock(value);
  return n === 0 ? undefined : n;
}

/**
 * Task 465: the names in "Do zamówienia", grouped by supplier ("Hairgum — Pomada (Brak w
 * magazynie); bez dostawcy — Szampon (zostało 3 szt.)") so the owner sees whom to call. The
 * suppliers are matched in any letter case, in alphabetical order, the products without one last.
 * Without any supplier the list stays as before ("Pomada (…), Szampon (…)").
 */
export function toOrderNames<T extends { name: string; supplier: string | null }>(
  items: readonly T[],
  state: (item: T) => string,
  noSupplier: string,
): string {
  const line = (list: readonly T[]) => list.map((x) => `${x.name} (${state(x)})`).join(', ');
  if (items.every((x) => x.supplier === null || x.supplier.trim() === '')) return line(items);
  const groups = new Map<string, { label: string; items: T[] }>();
  const without: T[] = [];
  for (const item of items) {
    const supplier = item.supplier?.trim() ?? '';
    if (supplier === '') {
      without.push(item);
      continue;
    }
    const key = supplier.toLocaleLowerCase();
    const group = groups.get(key) ?? { label: supplier, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const parts = [...groups.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((g) => `${g.label} — ${line(g.items)}`);
  if (without.length > 0) parts.push(`${noSupplier} — ${line(without)}`);
  return parts.join('; ');
}

/**
 * Task 473: how many pieces to order — enough for the next 30 days at the pace of the last 30
 * (`sold30`), and at least one more than "Kończy się przy" so the warning goes away; never less
 * than one. Only a suggestion: the owner can change the numbers in the text before sending it.
 */
export function orderQuantity(
  item: { stockQuantity: number | null; lowStockAt: number | null },
  sold30: number,
): number {
  const stock = Math.max(item.stockQuantity ?? 0, 0);
  const target = Math.max(sold30, (item.lowStockAt ?? 0) + 1, 1);
  return Math.max(target - stock, 1);
}

/**
 * Task 473: "Tekst zamówienia" — the products to order as a message for the supplier, one block
 * per supplier (grouped as in "Do zamówienia", the products without one last):
 *   Zamówienie — Hairgum:
 *   - Pomada — 2 szt.
 * Without any supplier there is one block with the plain title ("Zamówienie:").
 */
export function orderText<
  T extends {
    id: string;
    name: string;
    supplier: string | null;
    stockQuantity: number | null;
    lowStockAt: number | null;
  },
>(
  items: readonly T[],
  sold30: ReadonlyMap<string, number>,
  labels: { title: string; noSupplier: string; pieces: string },
): string {
  const lines = (list: readonly T[]) =>
    list.map(
      (x) =>
        `- ${x.name} — ${labels.pieces.replace('{n}', String(orderQuantity(x, sold30.get(x.id) ?? 0)))}`,
    );
  if (items.every((x) => x.supplier === null || x.supplier.trim() === '')) {
    return [`${labels.title}:`, ...lines(items)].join('\n');
  }
  const groups = new Map<string, { label: string; items: T[] }>();
  const without: T[] = [];
  for (const item of items) {
    const supplier = item.supplier?.trim() ?? '';
    if (supplier === '') {
      without.push(item);
      continue;
    }
    const key = supplier.toLocaleLowerCase();
    const group = groups.get(key) ?? { label: supplier, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const blocks = [...groups.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((g) => [`${labels.title} — ${g.label}:`, ...lines(g.items)].join('\n'));
  if (without.length > 0) {
    blocks.push([`${labels.title} — ${labels.noSupplier}:`, ...lines(without)].join('\n'));
  }
  return blocks.join('\n\n');
}
