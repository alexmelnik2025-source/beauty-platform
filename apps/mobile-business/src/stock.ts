/**
 * Task 431: the "W magazynie" field of a product — "" → null (the salon does not count the
 * pieces), "12" → 12; anything else (letters, a negative or a too big number) → undefined.
 */
export function parseStock(value: string): number | null | undefined {
  const text = value.trim();
  if (text === '') return null;
  return /^\d{1,6}$/.test(text) && Number(text) <= 100_000 ? Number(text) : undefined;
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
