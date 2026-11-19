/**
 * Task 494: "CSV bonów" — the salon's gift vouchers as a CSV file for the accountant: one line per
 * voucher, oldest first, with what was sold, what was paid with it and what is left. Same file
 * format as the visits CSV (task 30): UTF-8 with a byte order mark, ";" between the columns, a
 * decimal comma (point for en).
 */

import { amount, cell, type CsvLocale } from '../reports/visits-csv';

export type VoucherCsvStatus = 'active' | 'used' | 'expired' | 'cancelled';

export interface VoucherCsvLine {
  code: string;
  /** The day it was sold (the salon's own date). */
  soldDate: string;
  soldBy: string;
  recipient: string | null;
  amountGrosze: number;
  balanceGrosze: number;
  /** The last day it may be used, or null for no end. */
  validUntil: string | null;
  status: VoucherCsvStatus;
  note: string | null;
}

interface VoucherCsvTexts {
  header: [
    code: string,
    soldDate: string,
    soldBy: string,
    recipient: string,
    amount: string,
    used: string,
    left: string,
    validUntil: string,
    status: string,
    note: string,
  ];
  status: Record<VoucherCsvStatus, string>;
}

const TEXTS: Record<CsvLocale, VoucherCsvTexts> = {
  pl: {
    header: [
      'Kod',
      'Data sprzedaży',
      'Sprzedał(a)',
      'Dla kogo',
      'Kwota',
      'Wykorzystano',
      'Pozostało',
      'Ważny do',
      'Status',
      'Notatka',
    ],
    status: {
      active: 'Aktywny',
      used: 'Wykorzystany',
      expired: 'Wygasł',
      cancelled: 'Anulowany',
    },
  },
  uk: {
    header: [
      'Код',
      'Дата продажу',
      'Продав(ла)',
      'Для кого',
      'Сума',
      'Використано',
      'Залишок',
      'Дійсний до',
      'Статус',
      'Нотатка',
    ],
    status: {
      active: 'Активний',
      used: 'Використаний',
      expired: 'Термін минув',
      cancelled: 'Скасований',
    },
  },
  ru: {
    header: [
      'Код',
      'Дата продажи',
      'Продал(а)',
      'Для кого',
      'Сумма',
      'Использовано',
      'Остаток',
      'Действует до',
      'Статус',
      'Заметка',
    ],
    status: {
      active: 'Активен',
      used: 'Использован',
      expired: 'Срок истёк',
      cancelled: 'Отменён',
    },
  },
  en: {
    header: [
      'Code',
      'Sold on',
      'Sold by',
      'For',
      'Amount',
      'Used',
      'Left',
      'Valid until',
      'Status',
      'Note',
    ],
    status: { active: 'Active', used: 'Used', expired: 'Expired', cancelled: 'Cancelled' },
  },
};

export function vouchersCsv(lines: VoucherCsvLine[], locale: CsvLocale): string {
  const t = TEXTS[locale];
  const out = [t.header.map(cell).join(';')];
  for (const l of lines) {
    out.push(
      [
        cell(l.code),
        cell(l.soldDate),
        cell(l.soldBy),
        cell(l.recipient ?? ''),
        amount(l.amountGrosze, locale),
        amount(l.amountGrosze - l.balanceGrosze, locale),
        amount(l.balanceGrosze, locale),
        cell(l.validUntil ?? ''),
        cell(t.status[l.status]),
        cell(l.note ?? ''),
      ].join(';'),
    );
  }
  return `\uFEFF${out.join('\r\n')}\r\n`;
}

/**
 * Task 533: "CSV płatności bonami" — every payment taken with the salon's vouchers, oldest first:
 * when, which voucher, how much, for what, who took it and — when it was undone (task 530) — on
 * which day. For the accountant to match the till; same file format as above.
 */
export interface VoucherUseCsvLine {
  /** The salon's own date and time of the payment. */
  date: string;
  time: string;
  code: string;
  recipient: string | null;
  amountGrosze: number;
  note: string | null;
  by: string;
  /** The salon's own date it was undone, or null. */
  undoneDate: string | null;
}

const USE_HEADERS: Record<CsvLocale, string[]> = {
  pl: ['Data', 'Godzina', 'Kod bonu', 'Dla kogo', 'Kwota', 'Za co', 'Przyjął(a)', 'Cofnięta'],
  uk: ['Дата', 'Час', 'Код сертифіката', 'Для кого', 'Сума', 'За що', 'Прийняв(ла)', 'Скасована'],
  ru: ['Дата', 'Время', 'Код сертификата', 'Для кого', 'Сумма', 'За что', 'Принял(а)', 'Отменена'],
  en: ['Date', 'Time', 'Voucher code', 'For', 'Amount', 'Paid for', 'Taken by', 'Undone'],
};

export function voucherUsesCsv(lines: VoucherUseCsvLine[], locale: CsvLocale): string {
  const out = [USE_HEADERS[locale].map(cell).join(';')];
  for (const l of lines) {
    out.push(
      [
        cell(l.date),
        cell(l.time),
        cell(l.code),
        cell(l.recipient ?? ''),
        amount(l.amountGrosze, locale),
        cell(l.note ?? ''),
        cell(l.by),
        cell(l.undoneDate ?? ''),
      ].join(';'),
    );
  }
  return `\uFEFF${out.join('\r\n')}\r\n`;
}
