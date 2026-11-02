import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client';
import type {
  NotificationData,
  NotificationResponse,
  NOTIFICATION_TYPES,
} from '../common/system.responses';
import { PrismaService } from '../prisma/prisma.service';
import { instantToLocal } from '../scheduling/time';

/** Appointment events that people in the salon are told about. */
const KINDS = {
  confirmed: 'appointment.booked',
  created: 'appointment.created',
  rescheduled: 'appointment.rescheduled',
  cancelled: 'appointment.cancelled',
} as const satisfies Record<string, (typeof NOTIFICATION_TYPES)[number]>;

export const listNotificationsSchema = z.object({
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Id of the last notification of the previous page (newest first). */
  before: z.uuid().optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsSchema>;

export const markReadSchema = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(100) }),
  z.object({ all: z.literal(true) }),
]);
export type MarkReadInput = z.infer<typeof markReadSchema>;

export type { NotificationResponse } from '../common/system.responses';

/**
 * The in-app notification feed. Rows are written inside the transaction of the
 * change itself, so a notification exists exactly when the change does.
 * Who is told:
 * - the staff member whose calendar the appointment is in (also the previous one after a move);
 * - for changes made by the client (online booking, cancel or move by link): also the
 *   owners and the managers of the location;
 * - never the person who made the change.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async onAppointmentEvent(
    tx: Prisma.TransactionClient,
    appointmentId: string,
    event: string,
    actorUserId: string | null,
    previousStaffId?: string,
  ): Promise<void> {
    const type = KINDS[event as keyof typeof KINDS];
    if (!type) return;
    const appointment = await tx.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      include: {
        location: true,
        service: { select: { name: true } },
        staff: { select: { id: true, displayName: true, userId: true } },
        customer: { select: { name: true } },
      },
    });
    const orgId = appointment.location.organizationId;

    const staffUserIds = new Set<string>();
    if (appointment.staff.userId) staffUserIds.add(appointment.staff.userId);
    if (previousStaffId && previousStaffId !== appointment.staffId) {
      const previous = await tx.staffMember.findUnique({ where: { id: previousStaffId } });
      if (previous?.userId) staffUserIds.add(previous.userId);
    }
    const byClient = actorUserId === null;
    const members = await tx.membership.findMany({
      where: {
        organizationId: orgId,
        status: 'active',
        OR: [
          { userId: { in: [...staffUserIds] } },
          ...(byClient
            ? [
                { role: 'owner' as const },
                {
                  role: 'manager' as const,
                  locations: { some: { locationId: appointment.locationId } },
                },
              ]
            : []),
        ],
      },
      select: { userId: true },
    });
    const recipients = [...new Set(members.map((m) => m.userId))].filter(
      (id) => id !== actorUserId,
    );
    if (recipients.length === 0) return;

    const local = instantToLocal(appointment.startAt.getTime(), appointment.location.timezone);
    const data: NotificationData = {
      locationId: appointment.locationId,
      start: appointment.startAt.toISOString(),
      date: local.date,
      time: local.time,
      serviceName: appointment.service.name,
      staffName: appointment.staff.displayName,
      customerName: appointment.customer?.name ?? null,
      by: byClient ? 'client' : 'salon',
    };
    await tx.notification.createMany({
      data: recipients.map((userId) => ({
        userId,
        organizationId: orgId,
        type,
        appointmentId,
        data,
      })),
    });
  }

  async list(userId: string, query: ListNotificationsQuery): Promise<NotificationResponse[]> {
    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        ...(query.unreadOnly ? { readAt: null } : {}),
        ...(query.before ? { id: { lt: query.before } } : {}),
        // Only organizations the user still works in.
        organization: { memberships: { some: { userId, status: 'active' } } },
      },
      orderBy: { id: 'desc' },
      take: query.limit,
    });
    return rows.map((n) => ({
      id: n.id,
      organizationId: n.organizationId,
      // Written only by onAppointmentEvent above, always in this shape.
      type: n.type as NotificationResponse['type'],
      appointmentId: n.appointmentId,
      data: n.data as NotificationData,
      read: n.readAt !== null,
      createdAt: n.createdAt.toISOString(),
    }));
  }

  async unreadCount(userId: string): Promise<{ unread: number }> {
    const unread = await this.prisma.notification.count({
      where: {
        userId,
        readAt: null,
        organization: { memberships: { some: { userId, status: 'active' } } },
      },
    });
    return { unread };
  }

  async markRead(userId: string, input: MarkReadInput): Promise<{ updated: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null, ...('ids' in input ? { id: { in: input.ids } } : {}) },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }
}
