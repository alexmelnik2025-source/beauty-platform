/**
 * Task 436: "CSV stanu magazynowego" — the salon's products with what is in stock, for ordering
 * from the supplier: product, price, sold or not, pieces in stock, the number at which it runs
 * out ("Kończy się przy") and whether to order it ("Do zamówienia" — it has run low). Same file
 * format as the other CSVs (task 30): UTF-8 with a byte order mark, ";" between the columns, a
 * decimal comma (point for en). An empty cell where the salon does not count the pieces.
 */

import { amount, cell, type CsvLocale } from '../reports/visits-csv';

export interface StockCsvLine {
  name: string;
  priceGrosze: number;
  active: boolean;
  stockQuantity: number | null;
  lowStockAt: number | null;
  lowStock: boolean;
}

type Header = [
  product: string,
  price: string,
  sold: string,
  inStock: string,
  lowStockAt: string,
  toOrder: string,
];

const TEXTS: Record<CsvLocale, { header: Header; yes: string; no: string }> = {
  pl: {
    header: ['Produkt', 'Cena', 'Sprzedajemy', 'W magazynie', 'Kończy się przy', 'Do zamówienia'],
    yes: 'tak',
    no: 'nie',
  },
  uk: {
    header: ['Товар', 'Ціна', 'Продаємо', 'На складі', 'Закінчується при', 'Замовити'],
    yes: 'так',
    no: 'ні',
  },
  ru: {
    header: ['Товар', 'Цена', 'Продаём', 'На складе', 'Заканчивается при', 'Заказать'],
    yes: 'да',
    no: 'нет',
  },
  en: {
    header: ['Product', 'Price', 'Sold', 'In stock', 'Runs low at', 'To order'],
    yes: 'yes',
    no: 'no',
  },
};

const count = (n: number | null): string => (n === null ? '' : String(n));

export function stockCsv(lines: StockCsvLine[], locale: CsvLocale): string {
  const t = TEXTS[locale];
  const out = [t.header.map(cell).join(';')];
  for (const l of lines) {
    out.push(
      [
        cell(l.name),
        amount(l.priceGrosze, locale),
        l.active ? t.yes : t.no,
        count(l.stockQuantity),
        count(l.lowStockAt),
        l.lowStock ? t.yes : t.no,
      ].join(';'),
    );
  }
  return `\uFEFF${out.join('\r\n')}\r\n`;
}
