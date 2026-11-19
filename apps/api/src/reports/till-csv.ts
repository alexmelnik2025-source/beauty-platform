/**
 * Task 238: the till of a period as a CSV file for the salon's accountant — a cash journal.
 * One line for every cash put into or taken out of the till (task 236) and one for every
 * "Zamknij kasę" (task 232), oldest first. Same file format as the visits CSV (task 30):
 * UTF-8 with a byte order mark, ";" between the columns, a decimal comma (point for en).
 * Task 553: the last column of a close is what that day brought not in cash ("Bez gotówki").
 */

import { amount, cell, type CsvLocale } from './visits-csv';

export type TillCsvKind = 'in' | 'out' | 'close';

export interface TillCsvLine {
  /** The till day (the salon's own date). */
  date: string;
  /** When it was noted, salon time ("HH:MM"). */
  time: string;
  kind: TillCsvKind;
  /** The cash put in or taken out; for a close — the cash counted. */
  amountGrosze: number;
  /** Close only: what should have been in the till when it was counted. */
  expectedGrosze: number | null;
  note: string | null;
  by: string;
  /**
   * Task 553, close only: what the day brought not in cash (card, BLIK, transfer, other — visits
   * and gift vouchers sold, task 552) when the file was made — to check with the terminal.
   */
  nonCashGrosze: number | null;
}

interface TillCsvTexts {
  header: [
    date: string,
    time: string,
    kind: string,
    amount: string,
    expected: string,
    difference: string,
    note: string,
    by: string,
    nonCash: string,
  ];
  kind: Record<TillCsvKind, string>;
}

const TEXTS: Record<CsvLocale, TillCsvTexts> = {
  pl: {
    header: [
      'Data',
      'Godzina',
      'Rodzaj',
      'Kwota',
      'Powinno być',
      'Różnica',
      'Powód / notatka',
      'Kto',
      'Bez gotówki',
    ],
    kind: { in: 'Wpłata do kasy', out: 'Wypłata z kasy', close: 'Zamknięcie kasy' },
  },
  uk: {
    header: [
      'Дата',
      'Час',
      'Операція',
      'Сума',
      'Мало бути',
      'Різниця',
      'Причина / нотатка',
      'Хто',
      'Безготівково',
    ],
    kind: { in: 'Внесення в касу', out: 'Вилучення з каси', close: 'Закриття каси' },
  },
  ru: {
    header: [
      'Дата',
      'Время',
      'Операция',
      'Сумма',
      'Должно быть',
      'Разница',
      'Причина / заметка',
      'Кто',
      'Безналично',
    ],
    kind: { in: 'Внесение в кассу', out: 'Изъятие из кассы', close: 'Закрытие кассы' },
  },
  en: {
    header: [
      'Date',
      'Time',
      'Entry',
      'Amount',
      'Should be',
      'Difference',
      'Reason / note',
      'By',
      'Not in cash',
    ],
    kind: { in: 'Cash put in', out: 'Cash taken out', close: 'Till closed' },
  },
};

export function tillCsv(lines: TillCsvLine[], locale: CsvLocale): string {
  const t = TEXTS[locale];
  const out = [t.header.map(cell).join(';')];
  for (const l of lines) {
    const close = l.kind === 'close' && l.expectedGrosze !== null;
    // The difference is a number with its sign ("-10,00"), written as it is — the formula
    // guard in cell() would turn a leading minus into text.
    const difference = close ? amount(l.amountGrosze - l.expectedGrosze!, locale) : '';
    out.push(
      [
        cell(l.date),
        cell(l.time),
        cell(t.kind[l.kind]),
        amount(l.amountGrosze, locale),
        close ? amount(l.expectedGrosze!, locale) : '',
        difference,
        cell(l.note ?? ''),
        cell(l.by),
        l.kind === 'close' && l.nonCashGrosze !== null ? amount(l.nonCashGrosze, locale) : '',
      ].join(';'),
    );
  }
  return `\uFEFF${out.join('\r\n')}\r\n`;
}
