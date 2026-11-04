import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import type { MembershipContext } from '../common/request-context';
import type {
  LoyaltyCoupon,
  LoyaltyProgram,
  LoyaltyReward,
  LoyaltyTransaction,
  Prisma,
} from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoyaltyLedger } from './loyalty-ledger';
import type {
  LoyaltyAccountResponse,
  LoyaltyCouponResponse,
  LoyaltyRewardResponse,
  LoyaltyProgramResponse,
  LoyaltyTiersResponse,
  LoyaltyTransactionResponse,
} from './loyalty.responses';
import { tierStatus } from './loyalty-tiers';
import type {
  AdjustLoyaltyBalanceInput,
  CancelLoyaltyCouponInput,
  CreateLoyaltyRewardInput,
  ListLoyaltyRewardsQuery,
  ListLoyaltyTransactionsQuery,
  RedeemLoyaltyRewardInput,
  ReplaceEarnRulesInput,
  ReplaceLoyaltyTiersInput,
  UpdateLoyaltyProgramInput,
  UpdateLoyaltyRewardInput,
} from './loyalty.schemas';

/** What a salon gets before it saves its program: switched off, nothing is earned. */
const DEFAULTS = {
  enabled: false,
  mode: 'stamps',
  stampsPerVisit: 1,
  pointsPerUnit: 0,
  spendUnitGrosze: 10_000,
  minSpendGrosze: 0,
  pointsValidityDays: null,
  maxDiscountPercent: 100,
  allowStacking: false,
  marketplaceEnabled: false,
} as const satisfies Omit<UpdateLoyaltyProgramInput, 'version'>;

const versionConflict = (what: string): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'VERSION_CONFLICT',
    `The ${what} was changed by someone else. Reload and try again`,
  );

const programDisabled = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'LOYALTY_DISABLED',
    'The loyalty program is switched off; rewards cannot be taken now',
  );

const programConflict = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'VERSION_CONFLICT',
    'The loyalty program was changed by someone else. Reload and try again',
  );

type TransactionWithCustomer = LoyaltyTransaction & {
  account: { customer: { id: string; name: string } };
};

const withCustomer = {
  account: { select: { customer: { select: { id: true, name: true } } } },
} as const;

/**
 * The salon's loyalty settings and its full history of operations. Only owners and
 * managers (the controller requires the role); balances change only in LoyaltyLedger.
 */
@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
    private readonly audit: AuditService,
    private readonly ledger: LoyaltyLedger,
  ) {}

  async getProgram(m: MembershipContext): Promise<LoyaltyProgramResponse> {
    const program = await this.prisma.loyaltyProgram.findUnique({
      where: { organizationId: m.organizationId },
    });
    return this.toProgramResponse(m, program);
  }

  async updateProgram(
    m: MembershipContext,
    userId: string,
    input: UpdateLoyaltyProgramInput,
  ): Promise<LoyaltyProgramResponse> {
    const { version, ...settings } = input;
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.loyaltyProgram.findUnique({
        where: { organizationId: m.organizationId },
      });
      if ((current?.version ?? 0) !== version) throw programConflict();
      if (current && current.mode !== settings.mode) {
        await this.assertNoBalances(tx, current.id);
      }
      if (current) {
        const result = await tx.loyaltyProgram.updateMany({
          where: { id: current.id, version },
          data: { ...settings, version: { increment: 1 } },
        });
        if (result.count !== 1) throw programConflict();
      } else {
        await tx.loyaltyProgram
          .create({ data: { organizationId: m.organizationId, ...settings } })
          .catch(() => {
            throw programConflict();
          });
      }
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId: userId,
          action: 'loyalty.program.updated',
          entityType: 'loyalty_program',
          metadata: { ...settings },
        },
        tx,
      );
    });
    return this.getProgram(m);
  }

  /** Replaces the per-service rules of one location; other locations keep theirs. */
  async replaceEarnRules(
    m: MembershipContext,
    userId: string,
    locationId: string,
    input: ReplaceEarnRulesInput,
  ): Promise<LoyaltyProgramResponse> {
    await this.access.writable(m, locationId);
    const ids = input.rules.map((r) => r.serviceId);
    const found = await this.prisma.service.count({ where: { id: { in: ids }, locationId } });
    if (found !== ids.length) throw notFound('Service');

    await this.prisma.$transaction(async (tx) => {
      const program = await tx.loyaltyProgram.upsert({
        where: { organizationId: m.organizationId },
        create: { organizationId: m.organizationId },
        update: {},
      });
      await tx.loyaltyEarnRule.deleteMany({
        where: { programId: program.id, service: { locationId } },
      });
      await tx.loyaltyEarnRule.createMany({
        data: input.rules.map((r) => ({
          programId: program.id,
          serviceId: r.serviceId,
          points: r.points,
        })),
      });
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId: userId,
          action: 'loyalty.earn_rules.replaced',
          entityType: 'location',
          entityId: locationId,
          metadata: { rules: input.rules },
        },
        tx,
      );
    });
    return this.getProgram(m);
  }

  async getAccount(m: MembershipContext, customerId: string): Promise<LoyaltyAccountResponse> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, organizationId: m.organizationId },
      select: { id: true, name: true },
    });
    if (!customer) throw notFound('Customer');
    const program = await this.prisma.loyaltyProgram.findUnique({
      where: { organizationId: m.organizationId },
      select: {
        id: true,
        mode: true,
        organizationId: true,
        tierBasis: true,
        tierPeriodDays: true,
        tiers: true,
      },
    });
    const account = program
      ? await this.prisma.loyaltyAccount.findUnique({
          where: { programId_customerId: { programId: program.id, customerId } },
          include: {
            transactions: {
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 100,
              include: withCustomer,
            },
            coupons: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 },
          },
        })
      : null;
    return {
      customer,
      mode: program?.mode ?? DEFAULTS.mode,
      balance: account?.balance ?? 0,
      lifetimeEarned: account?.lifetimeEarned ?? 0,
      transactions: (account?.transactions ?? []).map(toTransactionResponse),
      coupons: (account?.coupons ?? []).map(toCouponResponse),
      tier: program ? await tierStatus(this.prisma, program, customerId) : null,
    };
  }

  // ── Tiers (10e) ────────────────────────────────────────

  async getTiers(m: MembershipContext): Promise<LoyaltyTiersResponse> {
    const program = await this.prisma.loyaltyProgram.findUnique({
      where: { organizationId: m.organizationId },
      include: { tiers: { orderBy: { threshold: 'asc' } } },
    });
    return {
      basis: program?.tierBasis ?? 'visits',
      periodDays: program?.tierPeriodDays ?? 365,
      tiers: (program?.tiers ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        threshold: t.threshold,
        discountPercent: t.discountPercent,
      })),
    };
  }

  /** Replaces the salon's tiers; clients' tiers follow at once (they are counted, not stored). */
  async replaceTiers(
    m: MembershipContext,
    userId: string,
    input: ReplaceLoyaltyTiersInput,
  ): Promise<LoyaltyTiersResponse> {
    await this.prisma.$transaction(async (tx) => {
      const program = await tx.loyaltyProgram.upsert({
        where: { organizationId: m.organizationId },
        create: {
          organizationId: m.organizationId,
          tierBasis: input.basis,
          tierPeriodDays: input.periodDays,
        },
        update: { tierBasis: input.basis, tierPeriodDays: input.periodDays },
      });
      await tx.loyaltyTier.deleteMany({ where: { programId: program.id } });
      await tx.loyaltyTier.createMany({
        data: input.tiers.map((t) => ({ programId: program.id, ...t })),
      });
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId: userId,
          action: 'loyalty.tiers.replaced',
          entityType: 'loyalty_program',
          entityId: program.id,
          metadata: { ...input },
        },
        tx,
      );
    });
    return this.getTiers(m);
  }

  // ── Rewards catalogue (10a-2) ──────────────────────────

  async listRewards(
    m: MembershipContext,
    query: ListLoyaltyRewardsQuery,
  ): Promise<LoyaltyRewardResponse[]> {
    const rows = await this.prisma.loyaltyReward.findMany({
      where: {
        program: { organizationId: m.organizationId },
        ...(query.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ sortOrder: 'asc' }, { cost: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toRewardResponse);
  }

  async createReward(
    m: MembershipContext,
    userId: string,
    input: CreateLoyaltyRewardInput,
  ): Promise<LoyaltyRewardResponse> {
    await this.assertServicesVisible(m, input);
    const reward = await this.prisma.$transaction(async (tx) => {
      const program = await tx.loyaltyProgram.upsert({
        where: { organizationId: m.organizationId },
        create: { organizationId: m.organizationId },
        update: {},
      });
      const created = await tx.loyaltyReward.create({
        data: { programId: program.id, ...input },
      });
      await this.auditReward(tx, m, userId, 'loyalty.reward.created', created.id, input);
      return created;
    });
    return toRewardResponse(reward);
  }

  async updateReward(
    m: MembershipContext,
    userId: string,
    rewardId: string,
    input: UpdateLoyaltyRewardInput,
  ): Promise<LoyaltyRewardResponse> {
    await this.findReward(m, rewardId);
    await this.assertServicesVisible(m, input);
    const { version, ...fields } = input;
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.loyaltyReward.updateMany({
        where: { id: rewardId, version },
        data: { ...fields, version: { increment: 1 } },
      });
      if (result.count !== 1) throw versionConflict('reward');
      await this.auditReward(tx, m, userId, 'loyalty.reward.updated', rewardId, fields);
    });
    return toRewardResponse(await this.findReward(m, rewardId));
  }

  /** Removes a reward from the catalogue; coupons already taken stay valid. */
  async archiveReward(m: MembershipContext, userId: string, rewardId: string): Promise<void> {
    const reward = await this.findReward(m, rewardId);
    if (reward.archivedAt) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.loyaltyReward.update({
        where: { id: rewardId },
        data: { archivedAt: new Date(), version: { increment: 1 } },
      });
      await this.auditReward(tx, m, userId, 'loyalty.reward.archived', rewardId, {});
    });
  }

  // ── Client balances: exchange, cancel, manual correction (10a-2) ─────────

  /** The owner or manager exchanges a client's stamps or points for a reward (a coupon). */
  async redeem(
    m: MembershipContext,
    userId: string,
    customerId: string,
    input: RedeemLoyaltyRewardInput,
  ): Promise<LoyaltyCouponResponse> {
    await this.findCustomer(m, customerId);
    const reward = await this.prisma.loyaltyReward.findFirst({
      where: {
        id: input.rewardId,
        archivedAt: null,
        program: { organizationId: m.organizationId },
      },
      include: { program: true },
    });
    if (!reward) throw notFound('Reward');
    if (!reward.program.enabled) throw programDisabled();
    const coupon = await this.prisma.$transaction(async (tx) => {
      const created = await this.ledger.redeem(tx, reward.program, customerId, reward, userId);
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId: userId,
          action: 'loyalty.reward.redeemed',
          entityType: 'loyalty_coupon',
          entityId: created.id,
          metadata: { customerId, rewardId: reward.id, cost: created.cost },
        },
        tx,
      );
      return created;
    });
    return toCouponResponse(coupon);
  }

  /** Withdraws an unused coupon; the stamps or points go back to the client. */
  async cancelCoupon(
    m: MembershipContext,
    userId: string,
    couponId: string,
    input: CancelLoyaltyCouponInput,
  ): Promise<LoyaltyCouponResponse> {
    const coupon = await this.prisma.loyaltyCoupon.findFirst({
      where: { id: couponId, account: { program: { organizationId: m.organizationId } } },
    });
    if (!coupon) throw notFound('Coupon');
    if (coupon.status !== 'active') {
      throw new AppException(
        HttpStatus.CONFLICT,
        'COUPON_NOT_ACTIVE',
        'Only an unused coupon can be cancelled',
      );
    }
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const result = await this.ledger.cancelCoupon(tx, coupon, input.version, userId);
      if (!result) throw versionConflict('coupon');
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId: userId,
          action: 'loyalty.coupon.cancelled',
          entityType: 'loyalty_coupon',
          entityId: coupon.id,
          metadata: { cost: coupon.cost },
        },
        tx,
      );
      return result;
    });
    return toCouponResponse(cancelled);
  }

  /** A manual correction with a reason, e.g. a visit before the program started. */
  async adjust(
    m: MembershipContext,
    userId: string,
    customerId: string,
    input: AdjustLoyaltyBalanceInput,
  ): Promise<LoyaltyAccountResponse> {
    await this.findCustomer(m, customerId);
    await this.prisma.$transaction(async (tx) => {
      const program = await tx.loyaltyProgram.upsert({
        where: { organizationId: m.organizationId },
        create: { organizationId: m.organizationId },
        update: {},
      });
      await this.ledger.adjust(tx, program, customerId, input.points, input.reason, userId);
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId: userId,
          action: 'loyalty.balance.adjusted',
          entityType: 'customer',
          entityId: customerId,
          metadata: { points: input.points, reason: input.reason },
        },
        tx,
      );
    });
    return this.getAccount(m, customerId);
  }

  private async findCustomer(m: MembershipContext, customerId: string): Promise<void> {
    const found = await this.prisma.customer.count({
      where: { id: customerId, organizationId: m.organizationId },
    });
    if (!found) throw notFound('Customer');
  }

  private async findReward(m: MembershipContext, rewardId: string): Promise<LoyaltyReward> {
    const reward = await this.prisma.loyaltyReward.findFirst({
      where: { id: rewardId, program: { organizationId: m.organizationId } },
    });
    if (!reward) throw notFound('Reward');
    return reward;
  }

  /** Services in a reward must be the salon's, and for a manager in their own locations. */
  private async assertServicesVisible(
    m: MembershipContext,
    input: { freeServiceId: string | null; serviceIds: string[] },
  ): Promise<void> {
    const ids = [
      ...new Set([...input.serviceIds, ...(input.freeServiceId ? [input.freeServiceId] : [])]),
    ];
    if (ids.length === 0) return;
    const found = await this.prisma.service.count({
      where: {
        id: { in: ids },
        location: { organizationId: m.organizationId },
        ...(m.role === 'owner' ? {} : { locationId: { in: m.locationIds } }),
      },
    });
    if (found !== ids.length) throw notFound('Service');
  }

  private auditReward(
    tx: Prisma.TransactionClient,
    m: MembershipContext,
    userId: string,
    action: string,
    rewardId: string,
    metadata: object,
  ): Promise<unknown> {
    return this.audit.record(
      {
        organizationId: m.organizationId,
        actorUserId: userId,
        action,
        entityType: 'loyalty_reward',
        entityId: rewardId,
        metadata: { ...metadata },
      },
      tx,
    );
  }

  async listTransactions(
    m: MembershipContext,
    query: ListLoyaltyTransactionsQuery,
  ): Promise<LoyaltyTransactionResponse[]> {
    const rows = await this.prisma.loyaltyTransaction.findMany({
      where: {
        account: {
          program: { organizationId: m.organizationId },
          ...(query.customerId ? { customerId: query.customerId } : {}),
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      include: withCustomer,
    });
    return rows.map(toTransactionResponse);
  }

  /** Stamps cannot turn into points (or back): switch only while nobody has a balance. */
  private async assertNoBalances(tx: Prisma.TransactionClient, programId: string): Promise<void> {
    const withBalance = await tx.loyaltyAccount.count({
      where: { programId, balance: { gt: 0 } },
    });
    if (withBalance > 0) {
      throw new AppException(
        HttpStatus.CONFLICT,
        'LOYALTY_MODE_LOCKED',
        'Clients already have stamps or points; the program type cannot be changed now',
      );
    }
  }

  private async toProgramResponse(
    m: MembershipContext,
    program: LoyaltyProgram | null,
  ): Promise<LoyaltyProgramResponse> {
    const rules = program
      ? await this.prisma.loyaltyEarnRule.findMany({
          where: {
            programId: program.id,
            ...(m.role === 'owner' ? {} : { service: { locationId: { in: m.locationIds } } }),
          },
          include: { service: { select: { name: true, locationId: true } } },
          orderBy: [{ service: { locationId: 'asc' } }, { service: { sortOrder: 'asc' } }],
        })
      : [];
    const settings = program ?? DEFAULTS;
    return {
      enabled: settings.enabled,
      mode: settings.mode,
      stampsPerVisit: settings.stampsPerVisit,
      pointsPerUnit: settings.pointsPerUnit,
      spendUnitGrosze: settings.spendUnitGrosze,
      minSpendGrosze: settings.minSpendGrosze,
      pointsValidityDays: settings.pointsValidityDays,
      maxDiscountPercent: settings.maxDiscountPercent,
      allowStacking: settings.allowStacking,
      marketplaceEnabled: settings.marketplaceEnabled,
      earnRules: rules.map((r) => ({
        serviceId: r.serviceId,
        serviceName: r.service.name,
        locationId: r.service.locationId,
        points: r.points,
      })),
      version: program?.version ?? 0,
    };
  }
}

function toTransactionResponse(t: TransactionWithCustomer): LoyaltyTransactionResponse {
  return {
    id: t.id,
    customer: t.account.customer,
    type: t.type,
    points: t.points,
    balanceAfter: t.balanceAfter,
    appointmentId: t.appointmentId,
    reversesId: t.reversesId,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    actorUserId: t.actorUserId,
    note: t.note,
    createdAt: t.createdAt.toISOString(),
  };
}

function toRewardResponse(r: LoyaltyReward): LoyaltyRewardResponse {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    discountPercent: r.discountPercent,
    freeServiceId: r.freeServiceId,
    cost: r.cost,
    serviceIds: r.serviceIds,
    couponValidityDays: r.couponValidityDays,
    sortOrder: r.sortOrder,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    version: r.version,
  };
}

function toCouponResponse(c: LoyaltyCoupon): LoyaltyCouponResponse {
  const expired = c.status === 'active' && c.expiresAt !== null && c.expiresAt <= new Date();
  return {
    id: c.id,
    code: c.code,
    rewardId: c.rewardId,
    name: c.name,
    kind: c.kind,
    discountPercent: c.discountPercent,
    freeServiceId: c.freeServiceId,
    serviceIds: c.serviceIds,
    cost: c.cost,
    status: expired ? 'expired' : c.status,
    expiresAt: c.expiresAt?.toISOString() ?? null,
    usedAt: c.usedAt?.toISOString() ?? null,
    usedAppointmentId: c.usedAppointmentId,
    cancelledAt: c.cancelledAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    version: c.version,
  };
}
