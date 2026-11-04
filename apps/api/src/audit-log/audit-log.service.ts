import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { responseSchema } from '../common/openapi';
import type { MembershipContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';

export const auditLogQuerySchema = z
  .object({
    /** Entries older than this one (the `next` of the previous page). */
    before: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const auditLogSchema = responseSchema(
  'AuditLog',
  z.strictObject({
    items: z.array(
      z.strictObject({
        id: z.string(),
        at: z.string(),
        action: z.string().describe('e.g. service.updated, staff.time_off_added'),
        entityType: z.string(),
        entityId: z.string().nullable(),
        entityName: z
          .string()
          .nullable()
          .describe('Current name of the service, specialist, client… (null when gone)'),
        actor: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
        fields: z
          .array(z.string())
          .nullable()
          .describe('Names of the changed fields (never their values)'),
        date: z.string().nullable().describe('The day a schedule change is about'),
      }),
    ),
    next: z.string().nullable().describe('Pass as `before` for older entries'),
  }),
);
export type AuditLogResponse = z.infer<typeof auditLogSchema>;

/** Reads only what is safe to show from the stored metadata: field names and a date. */
function safeMetadata(value: unknown): { fields: string[] | null; date: string | null } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { fields: null, date: null };
  }
  const meta = value as Record<string, unknown>;
  const fields = Array.isArray(meta.fields)
    ? meta.fields.filter((f): f is string => typeof f === 'string')
    : null;
  const date =
    typeof meta.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(meta.date)
      ? meta.date.slice(0, 10)
      : null;
  return { fields, date };
}

/**
 * Task 23: "Dziennik zmian" — who changed what in the salon (services, team, schedules,
 * permissions, clients, loyalty, settings), newest first. Owner only. Bookings have their
 * own history on each visit. Values are never shown, only field names.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(m: MembershipContext, query: AuditLogQuery): Promise<AuditLogResponse> {
    const organizationId = m.organizationId;
    const rows = await this.prisma.auditLog.findMany({
      where: {
        organizationId,
        ...(query.before ? { id: { lt: query.before } } : {}),
      },
      // uuid v7 ids grow with time: the id is a stable cursor for "older than".
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const names = await this.names(organizationId, page);
    const actorIds = [...new Set(page.map((r) => r.actorUserId).filter((id) => id !== null))];
    const actors = await this.prisma.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, name: true },
    });
    const actorById = new Map(actors.map((a) => [a.id, a]));
    return {
      items: page.map((r) => {
        const actor = r.actorUserId ? actorById.get(r.actorUserId) : undefined;
        return {
          id: r.id,
          at: r.createdAt.toISOString(),
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          entityName: (r.entityId && names.get(`${r.entityType}:${r.entityId}`)) ?? null,
          actor: actor ? { id: actor.id, name: actor.name } : null,
          ...safeMetadata(r.metadata),
        };
      }),
      next: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** Current names of the things the entries are about, all within this organization. */
  private async names(
    organizationId: string,
    rows: { entityType: string; entityId: string | null }[],
  ): Promise<Map<string, string>> {
    const ids = (type: string) => [
      ...new Set(rows.filter((r) => r.entityType === type && r.entityId).map((r) => r.entityId!)),
    ];
    const inOrg = { location: { organizationId } };
    const [services, staff, customers, locations, rewards, serviceCats, staffCats, members, offs] =
      await Promise.all([
        this.prisma.service.findMany({ where: { id: { in: ids('service') }, ...inOrg } }),
        this.prisma.staffMember.findMany({ where: { id: { in: ids('staff_member') }, ...inOrg } }),
        this.prisma.customer.findMany({ where: { id: { in: ids('customer') }, organizationId } }),
        this.prisma.location.findMany({ where: { id: { in: ids('location') }, organizationId } }),
        this.prisma.loyaltyReward.findMany({
          where: { id: { in: ids('loyalty_reward') }, program: { organizationId } },
        }),
        this.prisma.serviceCategory.findMany({
          where: { id: { in: ids('service_category') }, ...inOrg },
        }),
        this.prisma.staffCategory.findMany({
          where: { id: { in: ids('staff_category') }, organizationId },
        }),
        this.prisma.membership.findMany({
          where: { id: { in: ids('membership') }, organizationId },
          include: { user: { select: { name: true } } },
        }),
        this.prisma.timeOff.findMany({
          where: { id: { in: ids('time_off') }, staff: inOrg },
          include: { staff: { select: { displayName: true } } },
        }),
      ]);
    const map = new Map<string, string>();
    for (const s of services) map.set(`service:${s.id}`, s.name);
    for (const s of staff) map.set(`staff_member:${s.id}`, s.displayName);
    for (const c of customers) map.set(`customer:${c.id}`, c.name);
    for (const l of locations) map.set(`location:${l.id}`, l.name);
    for (const r of rewards) map.set(`loyalty_reward:${r.id}`, r.name);
    for (const c of serviceCats) map.set(`service_category:${c.id}`, c.name);
    for (const c of staffCats) map.set(`staff_category:${c.id}`, c.name);
    for (const mm of members) map.set(`membership:${mm.id}`, mm.user.name);
    for (const t of offs) map.set(`time_off:${t.id}`, t.staff.displayName);
    return map;
  }
}
