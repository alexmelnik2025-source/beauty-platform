/**
 * Task 454: "CSV historii magazynu" — every change of the pieces in stock in a period, for the
 * salon's accountant or a stocktaking: when, the product, what happened (sold at a visit, sale
 * removed, delivery, changed by hand, write-off), plus or minus pieces, pieces after it, who did it
 * and the reason of a write-off. Same file format as the other CSVs (task 30): UTF-8 with a byte
 * order mark, ";" between the columns. No client data at all. Only for owners and managers.
 */

import { cell, type CsvLocale } from './visits-csv';

export type StockHistoryKind =
  'sale' | 'sale_removed' | 'delivery' | 'correction' | 'write_off' | 'stocktake';

export interface StockHistoryCsvLine {
  /** The change's date and time in the salon's own time. */
  date: string;
  time: string;
  product: string;
  kind: StockHistoryKind;
  change: number;
  /** null = the salon stopped counting the pieces. */
  quantityAfter: number | null;
  byName: string | null;
  note: string | null;
}

type Header = [
  date: string,
  time: string,
  product: string,
  what: string,
  change: string,
  after: string,
  who: string,
  reason: string,
];

const TEXTS: Record<CsvLocale, { header: Header; kinds: Record<StockHistoryKind, string> }> = {
  pl: {
    header: ['Data', 'Godzina', 'Produkt', 'Zmiana', 'Sztuk', 'Stan po', 'Kto', 'Powód'],
    kinds: {
      sale: 'Sprzedaż przy wizycie',
      sale_removed: 'Sprzedaż usunięta',
      delivery: 'Dostawa',
      correction: 'Zmiana ręczna',
      write_off: 'Odpis',
      stocktake: 'Inwentaryzacja',
    },
  },
  uk: {
    header: ['Дата', 'Час', 'Товар', 'Зміна', 'Штук', 'Залишок після', 'Хто', 'Причина'],
    kinds: {
      sale: 'Продаж на візиті',
      sale_removed: 'Продаж видалено',
      delivery: 'Поставка',
      correction: 'Зміна вручну',
      write_off: 'Списання',
      stocktake: 'Інвентаризація',
    },
  },
  ru: {
    header: ['Дата', 'Время', 'Товар', 'Изменение', 'Штук', 'Остаток после', 'Кто', 'Причина'],
    kinds: {
      sale: 'Продажа на визите',
      sale_removed: 'Продажа удалена',
      delivery: 'Поставка',
      correction: 'Изменение вручную',
      write_off: 'Списание',
      stocktake: 'Инвентаризация',
    },
  },
  en: {
    header: ['Date', 'Time', 'Product', 'Change', 'Pieces', 'In stock after', 'By', 'Reason'],
    kinds: {
      sale: 'Sold at a visit',
      sale_removed: 'Sale removed',
      delivery: 'Delivery',
      correction: 'Changed by hand',
      write_off: 'Write-off',
      stocktake: 'Stocktake',
    },
  },
};

export function stockHistoryCsv(lines: StockHistoryCsvLine[], locale: CsvLocale): string {
  const t = TEXTS[locale];
  const out = [t.header.map(cell).join(';')];
  for (const l of lines) {
    out.push(
      [
        l.date,
        l.time,
        cell(l.product),
        cell(t.kinds[l.kind]),
        l.change > 0 ? `+${l.change}` : String(l.change),
        l.quantityAfter === null ? '' : String(l.quantityAfter),
        cell(l.byName ?? ''),
        cell(l.note ?? ''),
      ].join(';'),
    );
  }
  return `\uFEFF${out.join('\r\n')}\r\n`;
}
