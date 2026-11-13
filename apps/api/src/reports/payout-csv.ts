/**
 * Task 391: "CSV wypłat" — what each specialist earned in a period, for the salon's accountant:
 * visits, what their paid visits brought, the commission (task 373), the tips (task 229) and
 * the total to pay out. Same file format as the visits CSV (task 30): UTF-8 with a byte order
 * mark, ";" between the columns, a decimal comma (point for en). No client data at all.
 */

import { amount, cell, type CsvLocale } from './visits-csv';

export interface PayoutCsvLine {
  staff: string;
  completed: number;
  paid: number;
  revenueGrosze: number;
  /** null = the salon set no commission for this specialist. */
  commissionPercent: number | null;
  commissionGrosze: number | null;
  tipsGrosze: number;
}

type Header = [
  staff: string,
  completed: string,
  paid: string,
  revenue: string,
  percent: string,
  commission: string,
  tips: string,
  payout: string,
];

const HEADERS: Record<CsvLocale, { header: Header; total: string }> = {
  pl: {
    header: [
      'Specjalista',
      'Odbyte wizyty',
      'Opłacone wizyty',
      'Przychód',
      'Prowizja %',
      'Prowizja',
      'Napiwki',
      'Do wypłaty',
    ],
    total: 'Razem',
  },
  uk: {
    header: [
      'Спеціаліст',
      'Візитів відбулося',
      'Оплачених візитів',
      'Виторг',
      'Комісія %',
      'Комісія',
      'Чайові',
      'До виплати',
    ],
    total: 'Разом',
  },
  ru: {
    header: [
      'Специалист',
      'Состоявшихся визитов',
      'Оплаченных визитов',
      'Выручка',
      'Комиссия %',
      'Комиссия',
      'Чаевые',
      'К выплате',
    ],
    total: 'Итого',
  },
  en: {
    header: [
      'Specialist',
      'Completed visits',
      'Paid visits',
      'Revenue',
      'Commission %',
      'Commission',
      'Tips',
      'To pay out',
    ],
    total: 'Total',
  },
};

/** 45.5 → "45,5" (pl, uk, ru) / "45.5" (en). */
function percent(value: number, locale: CsvLocale): string {
  const text = String(value);
  return locale === 'en' ? text : text.replace('.', ',');
}

export function payoutCsv(lines: PayoutCsvLine[], locale: CsvLocale): string {
  const t = HEADERS[locale];
  const out = [t.header.map(cell).join(';')];
  const sum = { completed: 0, paid: 0, revenue: 0, commission: 0, tips: 0 };
  for (const l of lines) {
    const commission = l.commissionGrosze ?? 0;
    sum.completed += l.completed;
    sum.paid += l.paid;
    sum.revenue += l.revenueGrosze;
    sum.commission += commission;
    sum.tips += l.tipsGrosze;
    out.push(
      [
        cell(l.staff),
        String(l.completed),
        String(l.paid),
        amount(l.revenueGrosze, locale),
        l.commissionPercent === null ? '' : percent(l.commissionPercent, locale),
        l.commissionGrosze === null ? '' : amount(l.commissionGrosze, locale),
        amount(l.tipsGrosze, locale),
        amount(commission + l.tipsGrosze, locale),
      ].join(';'),
    );
  }
  out.push(
    [
      cell(t.total),
      String(sum.completed),
      String(sum.paid),
      amount(sum.revenue, locale),
      '',
      amount(sum.commission, locale),
      amount(sum.tips, locale),
      amount(sum.commission + sum.tips, locale),
    ].join(';'),
  );
  return `﻿${out.join('\r\n')}\r\n`;
}
