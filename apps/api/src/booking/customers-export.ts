import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../common/audit.service';
import type { MembershipContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { instantToLocal } from '../scheduling/time';

/** Task 21: the owner downloads the salon's client list as a CSV file. */

export const exportCustomersSchema = z.object({
  /** Language of the column names and of "yes / no". */
  lang: z.enum(['pl', 'uk', 'ru', 'en']).default('pl'),
});
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
  ) {}

  /**
   * All clients of the organization (owners only — the controller checks the role),
   * separated by semicolons (Excel in Poland expects them), with a UTF-8 mark so
   * Polish, Ukrainian and Russian letters open correctly.
   */
  async csv(m: MembershipContext, userId: string, query: ExportCustomersQuery): Promise<string> {
    const organizationId = m.organizationId;
    const [customers, consents, visits, location] = await Promise.all([
      this.prisma.customer.findMany({
        where: { organizationId },
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
    ]);
    const timeZone = location?.timezone ?? 'Europe/Warsaw';
    const consent = new Map(consents.map((c) => [c.customerId, c.granted]));
    const done = new Map(visits.map((v) => [v.customerId, v]));
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
      metadata: { count: customers.length },
    });
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  }
}
