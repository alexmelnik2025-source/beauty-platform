/**
 * Task 436: "CSV stanu magazynowego" — the salon's products with what is in stock, for ordering
 * from the supplier: product, price, sold or not, pieces in stock, the number at which it runs
 * out ("Kończy się przy") and whether to order it ("Do zamówienia" — a sold product that has run
 * low or out, the same products the "Kończą się" line of "Produkty" lists). Same file
 * format as the other CSVs (task 30): UTF-8 with a byte order mark, ";" between the columns, a
 * decimal comma (point for en). An empty cell where the salon does not count the pieces.
 * Task 450: the last column is the purchase price ("Cena zakupu"), empty when not written — the
 * file is only for owners and managers.
 * Task 462: then the supplier ("Dostawca"), empty when not written.
 */

import { amount, cell, type CsvLocale } from '../reports/visits-csv';

export interface StockCsvLine {
  name: string;
  priceGrosze: number;
  active: boolean;
  stockQuantity: number | null;
  lowStockAt: number | null;
  lowStock: boolean;
  purchasePriceGrosze: number | null;
  supplier: string | null;
}

type Header = [
  product: string,
  price: string,
  sold: string,
  inStock: string,
  lowStockAt: string,
  toOrder: string,
  purchasePrice: string,
  supplier: string,
];

const TEXTS: Record<CsvLocale, { header: Header; yes: string; no: string }> = {
  pl: {
    header: [
      'Produkt',
      'Cena',
      'Sprzedajemy',
      'W magazynie',
      'Kończy się przy',
      'Do zamówienia',
      'Cena zakupu',
      'Dostawca',
    ],
    yes: 'tak',
    no: 'nie',
  },
  uk: {
    header: [
      'Товар',
      'Ціна',
      'Продаємо',
      'На складі',
      'Закінчується при',
      'Замовити',
      'Закупівельна ціна',
      'Постачальник',
    ],
    yes: 'так',
    no: 'ні',
  },
  ru: {
    header: [
      'Товар',
      'Цена',
      'Продаём',
      'На складе',
      'Заканчивается при',
      'Заказать',
      'Закупочная цена',
      'Поставщик',
    ],
    yes: 'да',
    no: 'нет',
  },
  en: {
    header: [
      'Product',
      'Price',
      'Sold',
      'In stock',
      'Runs low at',
      'To order',
      'Purchase price',
      'Supplier',
    ],
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
        l.active && (l.lowStock || l.stockQuantity === 0) ? t.yes : t.no,
        l.purchasePriceGrosze === null ? '' : amount(l.purchasePriceGrosze, locale),
        l.supplier === null ? '' : cell(l.supplier),
      ].join(';'),
    );
  }
  return `\uFEFF${out.join('\r\n')}\r\n`;
}
