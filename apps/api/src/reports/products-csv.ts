/**
 * Task 422: "CSV sprzedaży produktów" — every product sold at the visits of a period, for the
 * salon's accountant: when, who sold it, the product, how many, the price at the time of the sale
 * and the sum; then a total. Same file format as the visits CSV (task 30): UTF-8 with a byte
 * order mark, ";" between the columns, a decimal comma (point for en). No client data at all.
 *
 * Task 451: for owners and managers two more columns — the purchase price kept with the sale
 * ("Cena zakupu", empty when it was not written then) and the margin of the line ("Marża"); the
 * total row sums the margin of the lines that have one. A specialist's own file has neither.
 */

import { amount, cell, type CsvLocale } from './visits-csv';

export interface ProductsCsvLine {
  /** The visit's date and time in the salon's own time. */
  date: string;
  time: string;
  staff: string;
  product: string;
  quantity: number;
  unitPriceGrosze: number;
  /** Task 451: the purchase price at the time of the sale; null = not written then. */
  unitCostGrosze: number | null;
}

type Header = [
  date: string,
  time: string,
  staff: string,
  product: string,
  quantity: string,
  price: string,
  total: string,
];

const COST_HEADERS: Record<CsvLocale, [cost: string, margin: string]> = {
  pl: ['Cena zakupu', 'Marża'],
  uk: ['Закупівельна ціна', 'Маржа'],
  ru: ['Закупочная цена', 'Маржа'],
  en: ['Purchase price', 'Margin'],
};

const HEADERS: Record<CsvLocale, { header: Header; total: string }> = {
  pl: {
    header: ['Data', 'Godzina', 'Specjalista', 'Produkt', 'Ilość', 'Cena', 'Wartość'],
    total: 'Razem',
  },
  uk: {
    header: ['Дата', 'Час', 'Спеціаліст', 'Товар', 'Кількість', 'Ціна', 'Сума'],
    total: 'Разом',
  },
  ru: {
    header: ['Дата', 'Время', 'Специалист', 'Товар', 'Количество', 'Цена', 'Сумма'],
    total: 'Итого',
  },
  en: {
    header: ['Date', 'Time', 'Specialist', 'Product', 'Quantity', 'Price', 'Total'],
    total: 'Total',
  },
};

export function productsCsv(lines: ProductsCsvLine[], locale: CsvLocale, withCost = false): string {
  const t = HEADERS[locale];
  const out = [[...t.header, ...(withCost ? COST_HEADERS[locale] : [])].map(cell).join(';')];
  let quantity = 0;
  let total = 0;
  let margin: number | null = null;
  for (const l of lines) {
    const sum = l.quantity * l.unitPriceGrosze;
    quantity += l.quantity;
    total += sum;
    const lineMargin = l.unitCostGrosze === null ? null : sum - l.quantity * l.unitCostGrosze;
    if (lineMargin !== null) margin = (margin ?? 0) + lineMargin;
    out.push(
      [
        l.date,
        l.time,
        cell(l.staff),
        cell(l.product),
        String(l.quantity),
        amount(l.unitPriceGrosze, locale),
        amount(sum, locale),
        ...(withCost
          ? [
              l.unitCostGrosze === null ? '' : amount(l.unitCostGrosze, locale),
              lineMargin === null ? '' : amount(lineMargin, locale),
            ]
          : []),
      ].join(';'),
    );
  }
  out.push(
    [
      cell(t.total),
      '',
      '',
      '',
      String(quantity),
      '',
      amount(total, locale),
      ...(withCost ? ['', margin === null ? '' : amount(margin, locale)] : []),
    ].join(';'),
  );
  return `\uFEFF${out.join('\r\n')}\r\n`;
}
