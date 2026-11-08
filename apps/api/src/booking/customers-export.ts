import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../common/audit.service';
import type { MembershipContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { amount } from '../reports/visits-csv';
import { instantToLocal } from '../scheduling/time';
import { listCustomersSchema } from './booking.schemas';
import { CustomersService } from './customers.service';

/** Task 21: the owner downloads the salon's client list as a CSV file. */

export const exportCustomersSchema = listCustomersSchema
  .omit({ limit: true, offset: true })
  .extend({
    /** Language of the column names and of "yes / no". */
    lang: z.enum(['pl', 'uk', 'ru', 'en']).default('pl'),
  });

/**
 * Task 275: the filters of the client list (search, label, quick filters). With any of them the
 * file holds only the clients the list shows, in the list's order.
 */
const FILTERS = [
  'search',
  'inactiveDays',
  'tag',
  'birthdayDays',
  'marketing',
  'newDays',
  'overdue',
  'noShows',
  'once',
] as const;
export type ExportCustomersQuery = z.infer<typeof exportCustomersSchema>;

const HEADERS = {
  pl: {
    columns: [
      'Imię i nazwisko',
      'Telefon',
      'E-mail',
      'Język',
      'Tagi',
      'Zgoda na marketing',
      'Odbyte wizyty',
      'Ostatnia wizyta',
      'Klient od',
      'Urodziny',
      'Nieobecności (12 mies.)',
      'Następna wizyta',
      'Zapłacono łącznie',
      'Napiwki łącznie',
      'Średnia ocena',
      'Notatka',
    ],
    yes: 'tak',
    no: 'nie',
  },
  uk: {
    columns: [
      "Ім'я",
      'Телефон',
      'E-mail',
      'Мова',
      'Мітки',
      'Згода на розсилку',
      'Візитів відбулося',
      'Останній візит',
      'Клієнт з',
      'День народження',
      'Неявки (12 міс.)',
      'Наступний візит',
      'Сплачено разом',
      'Чайові разом',
      'Середня оцінка',
      'Нотатка',
    ],
    yes: 'так',
    no: 'ні',
  },
  ru: {
    columns: [
      'Имя',
      'Телефон',
      'E-mail',
      'Язык',
      'Метки',
      'Согласие на рассылку',
      'Визитов состоялось',
      'Последний визит',
      'Клиент с',
      'День рождения',
      'Неявки (12 мес.)',
      'Следующий визит',
      'Оплачено всего',
      'Чаевые всего',
      'Средняя оценка',
      'Заметка',
    ],
    yes: 'да',
    no: 'нет',
  },
  en: {
    columns: [
      'Name',
      'Phone',
      'Email',
      'Language',
      'Tags',
      'Marketing consent',
      'Completed visits',
      'Last visit',
      'Client since',
      'Birthday',
      'No-shows (12 months)',
      'Next visit',
      'Paid in total',
      'Tips in total',
      'Average rating',
      'Note',
    ],
    yes: 'yes',
    no: 'no',
  },
} as const;

/**
 * One CSV cell: always quoted. A text starting with = + - @ (or a tab / carriage
 * return) gets a leading apostrophe so spreadsheet programs never run it as a
 * formula — except a phone number made only of digits after "+", which is harmless.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) && !/^\+\d+$/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

@Injectable()
export class CustomersExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly customersService: CustomersService,
  ) {}

  /**
   * All clients of the organization (owners only — the controller checks the role),
   * separated by semicolons (Excel in Poland expects them), with a UTF-8 mark so
   * Polish, Ukrainian and Russian letters open correctly.
   */
  async csv(m: MembershipContext, userId: string, query: ExportCustomersQuery): Promise<string> {
    const organizationId = m.organizationId;
    const filters = Object.fromEntries(
      FILTERS.filter((key) => query[key] !== undefined && query[key] !== '').map((key) => [
        key,
        query[key],
      ]),
    );
    const filtered = Object.keys(filters).length > 0;
    const ids = filtered ? await this.customersService.matchingIds(m, query) : null;
    const [found, consents, visits, location, missed, upcoming, paid, locations, tipped, reviews] =
      await Promise.all([
        this.prisma.customer.findMany({
          where: { organizationId, ...(ids ? { id: { in: ids } } : {}) },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        }),
        this.prisma.consentRecord.findMany({
          where: { type: 'marketing', customer: { organizationId } },
          orderBy: [{ customerId: 'asc' }, { createdAt: 'desc' }],
          distinct: ['customerId'],
          select: { customerId: true, granted: true },
        }),
        this.prisma.appointment.groupBy({
          by: ['customerId'],
          where: { status: 'completed', location: { organizationId }, customerId: { not: null } },
          _count: { _all: true },
          _max: { startAt: true },
        }),
        this.prisma.location.findFirst({
          where: { organizationId },
          orderBy: { createdAt: 'asc' },
          select: { timezone: true },
        }),
        // Task 266: visits marked "did not come" in the last 365 days.
        this.prisma.appointment.groupBy({
          by: ['customerId'],
          where: {
            status: 'no_show',
            location: { organizationId },
            customerId: { not: null },
            startAt: { gte: new Date(Date.now() - 365 * 86_400_000) },
          },
          _count: { _all: true },
        }),
        // Task 267: the nearest booked visit from now on.
        this.prisma.appointment.groupBy({
          by: ['customerId'],
          where: {
            status: 'confirmed',
            location: { organizationId },
            customerId: { not: null },
            startAt: { gte: new Date() },
          },
          _min: { startAt: true },
        }),
        // Task 268: what the client paid — the same rule as "Zapłacono" in the client card.
        this.prisma.appointment.groupBy({
          by: ['customerId', 'locationId'],
          where: {
            location: { organizationId },
            customerId: { not: null },
            paidAt: { not: null },
            status: { not: 'cancelled' },
          },
          _sum: { priceGrosze: true, discountGrosze: true },
        }),
        this.prisma.location.findMany({
          where: { organizationId },
          select: { id: true, currency: true },
        }),
        // Task 289: the tips the client left — the same rule as "Napiwki łącznie" in the card.
        this.prisma.appointment.groupBy({
          by: ['customerId', 'locationId'],
          where: {
            location: { organizationId },
            customerId: { not: null },
            status: 'completed',
            tipGrosze: { gt: 0 },
          },
          _sum: { tipGrosze: true },
        }),
        // Task 303: the stars the client gave the visits — as "Oceny wizyt" in the card.
        this.prisma.visitReview.findMany({
          where: { location: { organizationId }, appointment: { customerId: { not: null } } },
          select: { rating: true, appointment: { select: { customerId: true } } },
        }),
      ]);
    // Task 275: the filtered list keeps its own order (e.g. the most recently due first).
    const position = new Map((ids ?? []).map((id, index) => [id, index]));
    const customers = ids
      ? [...found].sort((a, b) => position.get(a.id)! - position.get(b.id)!)
      : found;
    const timeZone = location?.timezone ?? 'Europe/Warsaw';
    const consent = new Map(consents.map((c) => [c.customerId, c.granted]));
    const done = new Map(visits.map((v) => [v.customerId, v]));
    const noShows = new Map(missed.map((v) => [v.customerId, v._count._all]));
    const next = new Map(upcoming.map((v) => [v.customerId, v._min.startAt]));
    const currencyOf = new Map(locations.map((l) => [l.id, l.currency]));
    const oneCurrency = new Set(locations.map((l) => l.currency)).size <= 1;
    // Per client and currency (task 268: paid visits; task 289: tips).
    const byCurrency = (
      rows: { customerId: string | null; locationId: string; grosze: number }[],
    ): Map<string, Map<string, number>> => {
      const result = new Map<string, Map<string, number>>();
      for (const row of rows) {
        if (!row.customerId) continue;
        const currency = currencyOf.get(row.locationId) ?? 'PLN';
        const sums = result.get(row.customerId) ?? new Map<string, number>();
        sums.set(currency, (sums.get(currency) ?? 0) + row.grosze);
        result.set(row.customerId, sums);
      }
      return result;
    };
    const paidBy = byCurrency(
      paid.map((row) => ({
        customerId: row.customerId,
        locationId: row.locationId,
        grosze: (row._sum.priceGrosze ?? 0) - (row._sum.discountGrosze ?? 0),
      })),
    );
    const tipsBy = byCurrency(
      tipped.map((row) => ({
        customerId: row.customerId,
        locationId: row.locationId,
        grosze: row._sum.tipGrosze ?? 0,
      })),
    );
    // One currency in the network: a plain number the spreadsheet can add up ("80,00");
    // several: each with its currency ("80,00 PLN + 20,00 EUR"), the biggest first.
    const moneyCell = (by: Map<string, Map<string, number>>, customerId: string): string => {
      const sums = [...(by.get(customerId) ?? [])].sort((a, b) => b[1] - a[1]);
      if (sums.length === 0) return oneCurrency ? amount(0, query.lang) : '';
      if (oneCurrency) return amount(sums[0]![1], query.lang);
      return sums.map(([currency, sum]) => `${amount(sum, query.lang)} ${currency}`).join(' + ');
    };
    const stars = new Map<string, { sum: number; count: number }>();
    for (const r of reviews) {
      const id = r.appointment.customerId;
      if (!id) continue;
      const s = stars.get(id) ?? { sum: 0, count: 0 };
      stars.set(id, { sum: s.sum + r.rating, count: s.count + 1 });
    }
    // "4,5" (one decimal, a comma except in English); empty without reviews.
    const ratingCell = (customerId: string): string => {
      const s = stars.get(customerId);
      if (!s) return '';
      const text = (Math.round((s.sum / s.count) * 10) / 10).toFixed(1);
      return query.lang === 'en' ? text : text.replace('.', ',');
    };
    const words = HEADERS[query.lang];
    const day = (d: Date | null | undefined) =>
      d ? instantToLocal(d.getTime(), timeZone).date : '';

    const lines = [words.columns.map(csvCell).join(';')];
    for (const c of customers) {
      const v = done.get(c.id);
      lines.push(
        [
          c.name,
          c.phone,
          c.email ?? '',
          c.locale,
          c.tags.join(', '),
          consent.get(c.id) ? words.yes : words.no,
          String(v?._count._all ?? 0),
          day(v?._max.startAt),
          day(c.createdAt),
          // Task 242: "15.03" — day and month, no year is kept.
          c.birthday ? `${c.birthday.slice(3)}.${c.birthday.slice(0, 2)}` : '',
          String(noShows.get(c.id) ?? 0),
          day(next.get(c.id)),
          moneyCell(paidBy, c.id),
          moneyCell(tipsBy, c.id),
          ratingCell(c.id),
          c.note ?? '',
        ]
          .map(csvCell)
          .join(';'),
      );
    }
    // Who took the client list, and when (GDPR: the salon can show it).
    await this.audit.record({
      organizationId,
      actorUserId: userId,
      action: 'customers.exported',
      entityType: 'organization',
      entityId: organizationId,
      metadata: { count: customers.length, ...(filtered ? { filters } : {}) },
    });
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  }
}
