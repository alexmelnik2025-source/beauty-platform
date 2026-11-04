import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppException, notFound } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import { responseSchema } from '../common/openapi';
import type { MembershipContext } from '../common/request-context';
import type { Prisma } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Task 62 (owner, 04.11.2026): "each specialist's service may cost differently — Marek 80,
 * Ilia 120 — or the same for everyone". The service keeps its base price; a specialist who
 * performs it may have an own price (null = the base price). New visits take the price of
 * the specialist they are booked with; booked visits keep theirs.
 */

export const replaceStaffPricesSchema = z
  .object({
    prices: z
      .array(
        z
          .object({
            staffId: z.uuid(),
            /** Hundredths of the location currency; null = the service's price. */
            priceGrosze: z.number().int().min(0).max(10_000_000).nullable(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type ReplaceStaffPricesInput = z.infer<typeof replaceStaffPricesSchema>;

/** Task 70: each specialist's own duration of a service (null = the service's duration). */
export const replaceStaffDurationsSchema = z
  .object({
    durations: z
      .array(
        z
          .object({
            staffId: z.uuid(),
            durationMinutes: z
              .number()
              .int()
              .min(5)
              .max(480)
              .refine((v) => v % 5 === 0, 'must be a multiple of 5 minutes')
              .nullable(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type ReplaceStaffDurationsInput = z.infer<typeof replaceStaffDurationsSchema>;

export const staffPricesSchema = responseSchema(
  'StaffPrices',
  z.strictObject({
    prices: z
      .array(
        z.strictObject({
          serviceId: z.string(),
          staffId: z.string(),
          priceGrosze: z.number().int(),
        }),
      )
      .describe('Only the specialists with an own price; everyone else takes the service price'),
    durations: z
      .array(
        z.strictObject({
          serviceId: z.string(),
          staffId: z.string(),
          durationMinutes: z.number().int(),
        }),
      )
      .describe(
        'Task 70: only the specialists with an own duration; the others take the service one',
      ),
  }),
);
export type StaffPricesResponse = z.infer<typeof staffPricesSchema>;

/** What a visit with this specialist takes: their own price and duration, else the service's. */
export interface StaffOffer {
  priceGrosze: number;
  durationMinutes: number;
}

export function offerOf(
  service: { priceGrosze: number; durationMinutes: number },
  link: { priceGrosze: number | null; durationMinutes: number | null } | null | undefined,
): StaffOffer {
  return {
    priceGrosze: link?.priceGrosze ?? service.priceGrosze,
    durationMinutes: link?.durationMinutes ?? service.durationMinutes,
  };
}

/** The price and duration of a service with this specialist (tasks 62 and 70). */
export async function offerFor(
  db: Prisma.TransactionClient,
  staffId: string,
  service: { id: string; priceGrosze: number; durationMinutes: number },
): Promise<StaffOffer> {
  const link = await db.staffService.findUnique({
    where: { staffId_serviceId: { staffId, serviceId: service.id } },
    select: { priceGrosze: true, durationMinutes: true },
  });
  return offerOf(service, link);
}

/** The list price of a service with this specialist: their own price, else the service's. */
export async function listPriceFor(
  db: Prisma.TransactionClient,
  staffId: string,
  service: { id: string; priceGrosze: number; durationMinutes: number },
): Promise<number> {
  return (await offerFor(db, staffId, service)).priceGrosze;
}

/** From the shortest to the longest duration among the specialists who perform a service. */
export function durationRange(
  baseMinutes: number,
  ownMinutes: (number | null)[],
): { fromMinutes: number; toMinutes: number } {
  const all = ownMinutes.length > 0 ? ownMinutes.map((m) => m ?? baseMinutes) : [baseMinutes];
  return { fromMinutes: Math.min(...all), toMinutes: Math.max(...all) };
}

/** From the lowest to the highest price among the specialists who perform a service. */
export function priceRange(
  basePriceGrosze: number,
  ownPrices: (number | null)[],
): { fromGrosze: number; toGrosze: number } {
  const all = ownPrices.length > 0 ? ownPrices.map((p) => p ?? basePriceGrosze) : [basePriceGrosze];
  return { fromGrosze: Math.min(...all), toGrosze: Math.max(...all) };
}

@Injectable()
export class StaffPricesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(m: MembershipContext, locationId: string): Promise<StaffPricesResponse> {
    await this.access.readable(m, locationId);
    return this.response(locationId);
  }

  /**
   * Sets the own prices of one service: listed specialists get the given price (null = the
   * service's), the others go back to the service's price. Only specialists who perform it.
   */
  async replace(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    serviceId: string,
    input: ReplaceStaffPricesInput,
  ): Promise<StaffPricesResponse> {
    await this.access.writable(m, locationId);
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, locationId },
      include: { staff: { select: { staffId: true } } },
    });
    if (!service) throw notFound('Service');
    const performs = new Set(service.staff.map((s) => s.staffId));
    checkStaff(performs, input.prices, 'prices');
    const own = new Map(input.prices.map((p) => [p.staffId, p.priceGrosze]));
    await this.prisma.$transaction(async (tx) => {
      for (const staffId of performs) {
        await tx.staffService.update({
          where: { staffId_serviceId: { staffId, serviceId } },
          data: { priceGrosze: own.get(staffId) ?? null },
        });
      }
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId,
          action: 'service.staff_prices_set',
          entityType: 'service',
          entityId: serviceId,
        },
        tx,
      );
    });
    return this.response(locationId);
  }

  /**
   * Task 70: sets the own durations of one service: listed specialists get the given duration
   * (null = the service's), the others go back to the service's duration. Booked visits keep
   * theirs; new visits and free times use the specialist's.
   */
  async replaceDurations(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    serviceId: string,
    input: ReplaceStaffDurationsInput,
  ): Promise<StaffPricesResponse> {
    await this.access.writable(m, locationId);
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, locationId },
      include: { staff: { select: { staffId: true } } },
    });
    if (!service) throw notFound('Service');
    const performs = new Set(service.staff.map((s) => s.staffId));
    checkStaff(performs, input.durations, 'durations');
    const own = new Map(input.durations.map((d) => [d.staffId, d.durationMinutes]));
    await this.prisma.$transaction(async (tx) => {
      for (const staffId of performs) {
        await tx.staffService.update({
          where: { staffId_serviceId: { staffId, serviceId } },
          data: { durationMinutes: own.get(staffId) ?? null },
        });
      }
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId,
          action: 'service.staff_durations_set',
          entityType: 'service',
          entityId: serviceId,
        },
        tx,
      );
    });
    return this.response(locationId);
  }

  private async response(locationId: string): Promise<StaffPricesResponse> {
    const rows = await this.prisma.staffService.findMany({
      where: {
        service: { locationId },
        OR: [{ priceGrosze: { not: null } }, { durationMinutes: { not: null } }],
      },
      orderBy: [{ serviceId: 'asc' }, { staffId: 'asc' }],
    });
    return {
      prices: rows
        .filter((r) => r.priceGrosze !== null)
        .map((r) => ({ serviceId: r.serviceId, staffId: r.staffId, priceGrosze: r.priceGrosze! })),
      durations: rows
        .filter((r) => r.durationMinutes !== null)
        .map((r) => ({
          serviceId: r.serviceId,
          staffId: r.staffId,
          durationMinutes: r.durationMinutes!,
        })),
    };
  }
}

/** Each specialist once, and only those who perform the service (400 otherwise). */
function checkStaff(performs: Set<string>, list: { staffId: string }[], field: string): void {
  const seen = new Set<string>();
  for (const [i, item] of list.entries()) {
    if (!performs.has(item.staffId) || seen.has(item.staffId)) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', `Invalid ${field}`, [
        {
          path: `${field}.${i}.staffId`,
          message: 'each specialist once, and only those who perform the service',
        },
      ]);
    }
    seen.add(item.staffId);
  }
}
