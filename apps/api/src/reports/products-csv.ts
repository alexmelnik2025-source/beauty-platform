/**
 * Task 422: "CSV sprzedaży produktów" — every product sold at the visits of a period, for the
 * salon's accountant: when, who sold it, the product, how many, the price at the time of the sale
 * and the sum; then a total. Same file format as the visits CSV (task 30): UTF-8 with a byte
 * order mark, ";" between the columns, a decimal comma (point for en). No client data at all.
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

export function productsCsv(lines: ProductsCsvLine[], locale: CsvLocale): string {
  const t = HEADERS[locale];
  const out = [t.header.map(cell).join(';')];
  let quantity = 0;
  let total = 0;
  for (const l of lines) {
    const sum = l.quantity * l.unitPriceGrosze;
    quantity += l.quantity;
    total += sum;
    out.push(
      [
        l.date,
        l.time,
        cell(l.staff),
        cell(l.product),
        String(l.quantity),
        amount(l.unitPriceGrosze, locale),
        amount(sum, locale),
      ].join(';'),
    );
  }
  out.push([cell(t.total), '', '', '', String(quantity), '', amount(total, locale)].join(';'));
  return `﻿${out.join('\r\n')}\r\n`;
}
