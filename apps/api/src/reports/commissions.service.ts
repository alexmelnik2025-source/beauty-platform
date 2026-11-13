import { Injectable } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import type { StaffCommissionsResponse } from './reports.responses';
import type { StaffCommissionInput } from './reports.schemas';

/** Tenths of a percent as stored (455) → percent (45.5); null stays null. */
export const permilleToPercent = (permille: number | null): number | null =>
  permille === null ? null : permille / 10;

/** Task 373: what the specialist gets of `revenueGrosze`; null when no commission is set. */
export const commissionGrosze = (revenueGrosze: number, permille: number | null): number | null =>
  permille === null ? null : Math.round((revenueGrosze * permille) / 1000);

/**
 * Task 373: "Prowizje" — each specialist's share of what their paid visits brought (price
 * minus discounts; tips are theirs anyway and are not part of it). Only owners and managers
 * of the location see and set them: a commission is a team member's pay, so it is not part
 * of the staff list everyone in the salon reads. In the report a specialist with
 * "viewOwnEarnings" sees their own.
 */
@Injectable()
export class CommissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(m: MembershipContext, locationId: string): Promise<StaffCommissionsResponse> {
    await this.access.writable(m, locationId);
    return this.view(locationId);
  }

  async set(
    m: MembershipContext,
    userId: string,
    locationId: string,
    staffId: string,
    input: StaffCommissionInput,
  ): Promise<StaffCommissionsResponse> {
    await this.access.writable(m, locationId);
    const permille =
      input.commissionPercent === null ? null : Math.round(input.commissionPercent * 10);
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.staffMember.updateMany({
        where: { id: staffId, locationId },
        data: { commissionPermille: permille },
      });
      if (result.count !== 1) throw notFound('Staff member');
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId: userId,
          action: 'staff.commission_set',
          entityType: 'staff_member',
          entityId: staffId,
          metadata: { fields: ['commissionPercent'] },
        },
        tx,
      );
    });
    return this.view(locationId);
  }

  private async view(locationId: string): Promise<StaffCommissionsResponse> {
    const staff = await this.prisma.staffMember.findMany({
      where: { locationId },
      select: { id: true, displayName: true, active: true, commissionPermille: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return {
      staff: staff.map((s) => ({
        staffId: s.id,
        displayName: s.displayName,
        active: s.active,
        commissionPercent: permilleToPercent(s.commissionPermille),
      })),
    };
  }
}
