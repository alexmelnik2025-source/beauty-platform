import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppException, forbidden, notFound } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import { appointmentStatusSchema, localeSchema } from '../common/enums.schemas';
import { responseSchema } from '../common/openapi';
import type { MembershipContext } from '../common/request-context';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { customerAnonymized } from './customers.service';

/** What an erased client is called everywhere (calendar, history, reports). */
export const ANONYMIZED_NAME = '—';

export const anonymizeCustomerSchema = z.object({ version: z.number().int().positive() }).strict();
export type AnonymizeCustomerInput = z.infer<typeof anonymizeCustomerSchema>;

/** Task 21: everything the salon keeps about one client, for a GDPR access request. */
export const customerExportSchema = responseSchema(
  'CustomerExport',
  z.strictObject({
    exportedAt: z.string(),
    salon: z.strictObject({ name: z.string() }),
    client: z.strictObject({
      id: z.string(),
      name: z.string(),
      phone: z.string(),
      email: z.string().nullable(),
      language: localeSchema,
      note: z.string().nullable(),
      tags: z.array(z.string()),
      createdAt: z.string(),
    }),
    consents: z.array(
      z.strictObject({
        type: z.string(),
        version: z.string(),
        granted: z.boolean(),
        at: z.string(),
      }),
    ),
    visits: z.array(
      z.strictObject({
        start: z.string(),
        place: z.string(),
        service: z.string(),
        specialist: z.string(),
        status: appointmentStatusSchema,
        priceGrosze: z.number().int(),
        discountGrosze: z.number().int(),
        currency: z.string(),
        paid: z.boolean(),
        note: z.string().nullable(),
        cancelReason: z.string().nullable(),
      }),
    ),
    loyalty: z.array(
      z.strictObject({
        balance: z.number().int(),
        history: z.array(
          z.strictObject({
            type: z.string(),
            points: z.number().int(),
            at: z.string(),
            note: z.string().nullable(),
          }),
        ),
        coupons: z.array(
          z.strictObject({
            code: z.string(),
            name: z.string(),
            status: z.string(),
            expiresAt: z.string().nullable(),
          }),
        ),
      }),
    ),
  }),
);
export type CustomerExportResponse = z.infer<typeof customerExportSchema>;

export const anonymizedCustomerSchema = responseSchema(
  'AnonymizedCustomer',
  z.strictObject({
    id: z.string(),
    anonymizedAt: z.string(),
    visitsKept: z.number().int().describe('Visits stay (without personal data) for statistics'),
  }),
);
export type AnonymizedCustomerResponse = z.infer<typeof anonymizedCustomerSchema>;

/**
 * Task 21 — the client's GDPR rights, handled by the salon owner (MVP spec: "export and
 * erasure on request, through the salon owner; erasure anonymises the client, visit
 * statistics stay"). Only owners: managers and staff get 403, another organization's
 * client is 404.
 */
@Injectable()
export class CustomerPrivacyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async export(
    m: MembershipContext,
    actorUserId: string,
    customerId: string,
  ): Promise<CustomerExportResponse> {
    const customer = await this.ownersClient(m, customerId);
    const [organization, consents, visits, accounts] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: m.organizationId } }),
      this.prisma.consentRecord.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.appointment.findMany({
        where: { customerId, status: { notIn: ['held', 'expired'] } },
        include: { location: true, service: true, staff: true },
        orderBy: { startAt: 'asc' },
      }),
      this.prisma.loyaltyAccount.findMany({
        where: { customerId },
        include: {
          transactions: { orderBy: { createdAt: 'asc' } },
          coupons: { orderBy: { createdAt: 'asc' } },
        },
      }),
    ]);
    await this.audit.record({
      organizationId: m.organizationId,
      actorUserId,
      action: 'customer.exported',
      entityType: 'customer',
      entityId: customerId,
    });
    return {
      exportedAt: new Date().toISOString(),
      salon: { name: organization.name },
      client: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        language: customer.locale,
        note: customer.note,
        tags: customer.tags,
        createdAt: customer.createdAt.toISOString(),
      },
      consents: consents.map((c) => ({
        type: c.type,
        version: c.version,
        granted: c.granted,
        at: c.createdAt.toISOString(),
      })),
      visits: visits.map((a) => ({
        start: a.startAt.toISOString(),
        place: a.location.name,
        service: a.service.name,
        specialist: a.staff.displayName,
        status: a.status,
        priceGrosze: a.priceGrosze,
        discountGrosze: a.discountGrosze,
        currency: a.location.currency,
        paid: a.paidAt !== null,
        note: a.note,
        cancelReason: a.cancelReason,
      })),
      loyalty: accounts.map((account) => ({
        balance: account.balance,
        history: account.transactions.map((t) => ({
          type: t.type,
          points: t.points,
          at: t.createdAt.toISOString(),
          note: t.note,
        })),
        coupons: account.coupons.map((c) => ({
          code: c.code,
          name: c.name,
          status: c.status,
          expiresAt: c.expiresAt?.toISOString() ?? null,
        })),
      })),
    };
  }

  /**
   * Erases the personal data: name, phone, email, note, tags, the visits' notes and
   * cancellation reasons, the contact typed during a hold, the client's name in staff
   * notifications and the manage links. Visits, prices and loyalty entries stay without
   * them. Refused while the client has upcoming visits (cancel them first).
   */
  async anonymize(
    m: MembershipContext,
    actorUserId: string,
    customerId: string,
    input: AnonymizeCustomerInput,
  ): Promise<AnonymizedCustomerResponse> {
    const customer = await this.ownersClient(m, customerId);
    if (customer.anonymizedAt) throw customerAnonymized();
    const upcoming = await this.prisma.appointment.count({
      where: { customerId, status: { in: ['held', 'confirmed'] }, endAt: { gt: new Date() } },
    });
    if (upcoming > 0) {
      throw new AppException(
        HttpStatus.CONFLICT,
        'CUSTOMER_HAS_UPCOMING_VISITS',
        'The client has upcoming visits: cancel them before erasing the data',
        [{ path: 'upcoming', message: String(upcoming) }],
      );
    }
    const now = new Date();
    const visitsKept = await this.prisma.$transaction(async (tx) => {
      const result = await tx.customer.updateMany({
        where: { id: customerId, organizationId: m.organizationId, version: input.version },
        data: {
          name: ANONYMIZED_NAME,
          phone: '',
          email: null,
          note: null,
          tags: [],
          anonymizedAt: now,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) {
        throw new AppException(
          HttpStatus.CONFLICT,
          'VERSION_CONFLICT',
          'The client was changed by someone else. Reload and try again',
        );
      }
      const visits = await tx.appointment.findMany({
        where: { customerId },
        select: { id: true },
      });
      const ids = visits.map((v) => v.id);
      if (ids.length > 0) {
        await tx.appointment.updateMany({
          where: { id: { in: ids } },
          data: { note: null, cancelReason: null, holdContact: Prisma.DbNull },
        });
        // Free text the client or staff typed when cancelling.
        await tx.$executeRaw`UPDATE appointment_event SET data = data - 'reason' WHERE appointment_id = ANY(${ids}::uuid[]) AND data ? 'reason'`;
        await tx.$executeRaw`UPDATE notification SET data = jsonb_set(data, '{customerName}', ${JSON.stringify(ANONYMIZED_NAME)}::jsonb) WHERE appointment_id = ANY(${ids}::uuid[]) AND data ? 'customerName'`;
        await tx.appointmentAccessToken.deleteMany({ where: { appointmentId: { in: ids } } });
        // Task 80b: the client's example photos.
        await tx.visitPhoto.deleteMany({ where: { appointmentId: { in: ids } } });
      }
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId,
          action: 'customer.anonymized',
          entityType: 'customer',
          entityId: customerId,
        },
        tx,
      );
      return ids.length;
    });
    return { id: customerId, anonymizedAt: now.toISOString(), visitsKept };
  }

  private async ownersClient(m: MembershipContext, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, organizationId: m.organizationId },
    });
    if (!customer) throw notFound('Customer');
    if (m.role !== 'owner') throw forbidden();
    return customer;
  }
}
