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
            review: { select: { rating: true, text: true, reply: true, createdAt: true } },
            productReservations: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: {
                name: true,
                quantity: true,
                unitPriceGrosze: true,
                status: true,
                createdAt: true,
              },
            },
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

    // Task 617: the waiting list keeps the client by e-mail, favorites and sessions by person.
    const [waitlist, favorites, sessions] = await Promise.all([
      this.prisma.waitlistEntry.findMany({
        where: { email: { equals: auth.email, mode: 'insensitive' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: VISIT_LIMIT,
        include: {
          location: { select: { name: true, organizationId: true } },
          service: { select: { name: true } },
          staff: { select: { displayName: true } },
        },
      }),
      this.prisma.clientFavorite.findMany({
        where: { personId: auth.personId },
        orderBy: { createdAt: 'asc' },
        include: { location: { select: { name: true } } },
      }),
      this.prisma.clientSession.findMany({
        where: { personId: auth.personId, expiresAt: { gt: now } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const salonOf = (organizationId: string) =>
      customers.find((c) => c.organizationId === organizationId);
    const waitlistBySalon = new Map<string, typeof waitlist>();
    for (const e of waitlist) {
      const key = salonOf(e.location.organizationId)?.id ?? `org:${e.location.organizationId}`;
      waitlistBySalon.set(key, [...(waitlistBySalon.get(key) ?? []), e]);
    }
    const exportWaitlist = (entries: typeof waitlist) =>
      entries.map((e) => ({
        salon: e.location.name,
        date: e.date.toISOString().slice(0, 10),
        service: e.service.name,
        staff: e.staff?.displayName ?? null,
        name: e.name,
        phone: e.phone,
        status: e.status,
        createdAt: e.createdAt.toISOString(),
      }));

    const salons: ClientExportSalon[] = customers.map((c) => ({
      salon: c.organization.locations[0]?.name ?? c.organization.name,
      company: c.organization.name,
      client: {
        name: c.name,
        phone: c.phone,
        email: c.email,
        locale: c.locale,
        birthday: c.birthday,
        createdAt: c.createdAt.toISOString(),
        wishes: { mood: c.wishMood, drink: c.wishDrink, note: c.wishNote },
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
          wishes: { mood: a.wishMood, drink: a.wishDrink, note: a.wishNote },
          review: a.review
            ? {
                rating: a.review.rating,
                text: a.review.text,
                reply: a.review.reply,
                at: a.review.createdAt.toISOString(),
              }
            : null,
          products: a.productReservations.map((r) => ({
            name: r.name,
            quantity: r.quantity,
            unitPriceGrosze: r.unitPriceGrosze,
            status: r.status,
            reservedAt: r.createdAt.toISOString(),
          })),
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
      waitlist: exportWaitlist(waitlistBySalon.get(c.id) ?? []),
    }));
    // Waiting-list entries in a salon where the client has no card yet (they never booked).
    for (const [key, entries] of waitlistBySalon) {
      if (!key.startsWith('org:')) continue;
      const first = entries[0]!;
      salons.push({
        salon: first.location.name,
        company: first.location.name,
        client: null,
        consents: [],
        visits: [],
        loyalty: [],
        waitlist: exportWaitlist(entries),
      });
    }

    return {
      exportedAt: now.toISOString(),
      person: {
        email: person.email,
        locale: person.locale,
        createdAt: person.createdAt.toISOString(),
      },
      salons,
      favorites: favorites.map((f) => ({
        salon: f.location.name,
        since: f.createdAt.toISOString(),
      })),
      sessions: sessions.map((k) => ({
        clientType: k.clientType,
        userAgent: k.userAgent,
        createdAt: k.createdAt.toISOString(),
        lastUsedAt: k.lastUsedAt.toISOString(),
        expiresAt: k.expiresAt.toISOString(),
      })),
    };
  }
}
