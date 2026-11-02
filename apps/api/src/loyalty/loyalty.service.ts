import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import type { MembershipContext } from '../common/request-context';
import type { LoyaltyProgram, LoyaltyTransaction, Prisma } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  LoyaltyAccountResponse,
  LoyaltyProgramResponse,
  LoyaltyTransactionResponse,
} from './loyalty.responses';
import type {
  ListLoyaltyTransactionsQuery,
  ReplaceEarnRulesInput,
  UpdateLoyaltyProgramInput,
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
      select: { id: true, mode: true },
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
          },
        })
      : null;
    return {
      customer,
      mode: program?.mode ?? DEFAULTS.mode,
      balance: account?.balance ?? 0,
      lifetimeEarned: account?.lifetimeEarned ?? 0,
      transactions: (account?.transactions ?? []).map(toTransactionResponse),
    };
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
