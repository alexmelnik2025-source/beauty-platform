import { Injectable } from '@nestjs/common';
import { DEFAULT_CURRENCY } from '../common/currency';
import type { LoyaltyCoupon, LoyaltyReward } from '../generated/prisma/client';
import { tierStatus } from '../loyalty/loyalty-tiers';
import { PrismaService } from '../prisma/prisma.service';
import type { ClientLoyaltyCard, ClientLoyaltyResponse } from './client-loyalty.responses';
import type { ClientAuth } from './client.service';

const COUPON_LIMIT = 20;
const HISTORY_LIMIT = 30;

/**
 * "My bonuses" (task 10c): the client's progress in every salon where they have a card
 * with their confirmed email. Read only: rewards are taken at the salon (10b) or when
 * booking (10d).
 */
@Injectable()
export class ClientLoyaltyService {
  constructor(private readonly prisma: PrismaService) {}

  async list(auth: ClientAuth): Promise<ClientLoyaltyResponse> {
    const now = new Date();
    const customers = await this.prisma.customer.findMany({
      where: { email: auth.email },
      select: { id: true, organizationId: true },
    });
    if (customers.length === 0) return { items: [] };
    const customerByOrg = new Map(customers.map((c) => [c.organizationId, c.id]));

    const programs = await this.prisma.loyaltyProgram.findMany({
      where: { organizationId: { in: [...customerByOrg.keys()] } },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            // The client knows the salon by its place, not the company's legal name (T9).
            locations: {
              select: { name: true, slug: true, onlineBookingEnabled: true, currency: true },
              orderBy: { createdAt: 'asc' },
              take: 20,
            },
          },
        },
        rewards: { where: { archivedAt: null }, orderBy: [{ cost: 'asc' }, { sortOrder: 'asc' }] },
        tiers: true,
        accounts: {
          where: { customerId: { in: customers.map((c) => c.id) } },
          include: {
            coupons: {
              where: { status: { not: 'cancelled' } },
              orderBy: { createdAt: 'desc' },
              take: 100,
            },
            transactions: {
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: HISTORY_LIMIT,
              include: { appointment: { select: { service: { select: { name: true } } } } },
            },
          },
        },
      },
    });

    // Names of services the rewards and coupons mention, in one query.
    const serviceIds = new Set<string>();
    const collect = (r: Pick<LoyaltyReward, 'freeServiceId' | 'serviceIds'>): void => {
      if (r.freeServiceId) serviceIds.add(r.freeServiceId);
      for (const id of r.serviceIds) serviceIds.add(id);
    };
    for (const p of programs) {
      p.rewards.forEach(collect);
      p.accounts.forEach((a) => a.coupons.forEach(collect));
    }
    const services = await this.prisma.service.findMany({
      where: { id: { in: [...serviceIds] } },
      select: { id: true, name: true },
    });
    const serviceName = new Map(services.map((s) => [s.id, s.name]));
    const names = (ids: string[]): string[] =>
      ids.map((id) => serviceName.get(id)).filter((n): n is string => n !== undefined);

    const items: ClientLoyaltyCard[] = [];
    for (const p of programs) {
      // The account of this salon's card for the person (an organization has one card per email).
      const customerId = customerByOrg.get(p.organizationId);
      const account = p.accounts.find((a) => a.customerId === customerId);
      const coupons = (account?.coupons ?? [])
        .map((c) => toCoupon(c, now, names, serviceName))
        .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'))
        .slice(0, COUPON_LIMIT);
      // A switched-off program is shown only while the client still holds a usable coupon.
      if (!p.enabled && !coupons.some((c) => c.status === 'active')) continue;

      const balance = account?.balance ?? 0;
      const rewards = p.rewards.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        discountPercent: r.discountPercent,
        freeServiceName: r.freeServiceId ? (serviceName.get(r.freeServiceId) ?? null) : null,
        serviceNames: names(r.serviceIds),
        cost: r.cost,
        missing: Math.max(0, r.cost - balance),
        couponValidityDays: r.couponValidityDays,
      }));
      const upcoming = rewards.find((r) => r.missing > 0);
      const online = p.organization.locations.find((l) => l.onlineBookingEnabled);
      const shownAs = online ?? p.organization.locations[0];
      const tier =
        p.enabled && customerId ? await tierStatus(this.prisma, p, customerId, now) : null;
      items.push({
        organization: { id: p.organization.id, name: shownAs?.name ?? p.organization.name },
        bookingSlug: online?.slug ?? null,
        currency: shownAs?.currency ?? DEFAULT_CURRENCY,
        enabled: p.enabled,
        mode: p.mode,
        balance,
        tier,
        lifetimeEarned: account?.lifetimeEarned ?? 0,
        earning: {
          stampsPerVisit: p.stampsPerVisit,
          pointsPerUnit: p.pointsPerUnit,
          spendUnitGrosze: p.spendUnitGrosze,
          minSpendGrosze: p.minSpendGrosze,
          pointsValidityDays: p.pointsValidityDays,
        },
        next: upcoming
          ? {
              rewardId: upcoming.id,
              missing: upcoming.missing,
              visits:
                p.mode === 'stamps' && p.stampsPerVisit > 0
                  ? Math.ceil(upcoming.missing / p.stampsPerVisit)
                  : null,
            }
          : null,
        rewards,
        coupons,
        history: (account?.transactions ?? []).map((t) => ({
          id: t.id,
          type: t.type,
          points: t.points,
          balanceAfter: t.balanceAfter,
          serviceName: t.appointment?.service.name ?? null,
          expiresAt: t.expiresAt?.toISOString() ?? null,
          createdAt: t.createdAt.toISOString(),
        })),
      });
    }
    // Salons where something is collected or waiting come first.
    const weight = (c: ClientLoyaltyCard): number =>
      c.coupons.some((x) => x.status === 'active') || c.balance > 0 ? 0 : 1;
    items.sort(
      (a, b) =>
        weight(a) - weight(b) || a.organization.name.localeCompare(b.organization.name, 'pl'),
    );
    return { items };
  }
}

function toCoupon(
  c: LoyaltyCoupon,
  now: Date,
  names: (ids: string[]) => string[],
  serviceName: Map<string, string>,
): ClientLoyaltyCard['coupons'][number] {
  const expired = c.status === 'active' && c.expiresAt !== null && c.expiresAt <= now;
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    kind: c.kind,
    discountPercent: c.discountPercent,
    freeServiceName: c.freeServiceId ? (serviceName.get(c.freeServiceId) ?? null) : null,
    serviceNames: names(c.serviceIds),
    status: expired ? 'expired' : c.status === 'used' ? 'used' : 'active',
    expiresAt: c.expiresAt?.toISOString() ?? null,
    usedAt: c.usedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}
