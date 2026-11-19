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
