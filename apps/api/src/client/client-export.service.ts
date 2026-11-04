import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { instantToLocal } from '../scheduling/time';
import type { ClientExportResponse, ClientExportSalon } from './client-export.responses';
import type { ClientAuth } from './client.service';

/** Held slots and expired holds are not visits: the client never confirmed them. */
const VISITS = ['confirmed', 'cancelled', 'completed', 'no_show'] as const;
/** A safety net, far above what one client books in one salon. */
const VISIT_LIMIT = 2000;
const LEDGER_LIMIT = 2000;

/**
 * "Download my data" (task 40): GDPR right of access and portability (art. 15 and 20).
 * Everything kept about the client in every salon where they have a card with their confirmed
 * email — the card, consents, visits, loyalty. The salon's internal notes and tags and
 * who on the team did what are left out, as everywhere in the client app.
 */
@Injectable()
export class ClientExportService {
  constructor(private readonly prisma: PrismaService) {}

  async export(auth: ClientAuth, now = new Date()): Promise<ClientExportResponse> {
    const person = await this.prisma.person.findUniqueOrThrow({ where: { id: auth.personId } });
    const customers = await this.prisma.customer.findMany({
      where: { email: auth.email },
      orderBy: { createdAt: 'asc' },
      include: {
        organization: {
          select: {
            name: true,
            locations: { select: { name: true }, orderBy: { createdAt: 'asc' }, take: 1 },
          },
        },
        consents: { orderBy: { createdAt: 'asc' } },
        appointments: {
          where: { status: { in: [...VISITS] } },
          orderBy: { startAt: 'desc' },
          take: VISIT_LIMIT,
          include: {
            location: { select: { name: true, timezone: true, currency: true } },
            service: { select: { name: true } },
            staff: { select: { displayName: true } },
          },
        },
        loyaltyAccounts: {
          orderBy: { createdAt: 'asc' },
          include: {
            transactions: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: LEDGER_LIMIT,
            },
            coupons: { orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });

    const salons: ClientExportSalon[] = customers.map((c) => ({
      salon: c.organization.locations[0]?.name ?? c.organization.name,
      company: c.organization.name,
      client: {
        name: c.name,
        phone: c.phone,
        email: c.email,
        locale: c.locale,
        createdAt: c.createdAt.toISOString(),
      },
      consents: c.consents.map((k) => ({
        type: k.type,
        version: k.version,
        granted: k.granted,
        ip: k.ip,
        at: k.createdAt.toISOString(),
      })),
      visits: c.appointments.map((a) => {
        const local = instantToLocal(a.startAt.getTime(), a.location.timezone);
        return {
          id: a.id,
          salon: a.location.name,
          date: local.date,
          time: local.time,
          start: a.startAt.toISOString(),
          durationMinutes: a.durationMinutes,
          service: a.service.name,
          staff: a.staff.displayName,
          status: a.status,
          source: a.source,
          priceGrosze: a.priceGrosze,
          discountGrosze: a.discountGrosze,
          currency: a.location.currency,
          paid: a.paidAt !== null,
          cancelledBy: a.cancelledBy,
          cancelReason: a.cancelReason,
          bookedAt: a.createdAt.toISOString(),
        };
      }),
      loyalty: c.loyaltyAccounts.map((account) => ({
        balance: account.balance,
        lifetimeEarned: account.lifetimeEarned,
        history: account.transactions.map((t) => ({
          type: t.type,
          points: t.points,
          balanceAfter: t.balanceAfter,
          expiresAt: t.expiresAt?.toISOString() ?? null,
          at: t.createdAt.toISOString(),
        })),
        coupons: account.coupons.map((k) => ({
          code: k.code,
          name: k.name,
          status:
            k.status === 'active' && k.expiresAt && k.expiresAt <= now
              ? ('expired' as const)
              : k.status,
          expiresAt: k.expiresAt?.toISOString() ?? null,
          usedAt: k.usedAt?.toISOString() ?? null,
          createdAt: k.createdAt.toISOString(),
        })),
      })),
    }));

    return {
      exportedAt: now.toISOString(),
      person: {
        email: person.email,
        locale: person.locale,
        createdAt: person.createdAt.toISOString(),
      },
      salons,
    };
  }
}
