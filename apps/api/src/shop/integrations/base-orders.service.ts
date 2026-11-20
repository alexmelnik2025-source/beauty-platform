import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import type { Prisma, ShopIntegration } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseApi } from './base-api';
import { SecretBox } from './secret-box';
import { closeRun } from './sync-runs';

/** What Base was last told about a reservation. */
export type BaseOrderState = 'reserved' | 'handed' | 'cancelled';

/** After this many failed attempts in a row a reservation waits for "Synchronizuj teraz". */
export const MAX_ORDER_FAILS = 5;

/**
 * Task 606: `baseOrderState` while addOrder is on its way and no order id is written down yet.
 * On the next round such a reservation is first looked for in Base (`BaseApi.findOrder`).
 */
export const SENDING = 'sending';

/** A visit that still counts (the same as for holding pieces). */
const LIVE_STATUSES = new Set(['confirmed', 'completed']);

const candidateInclude = {
  appointment: {
    select: {
      status: true,
      startAt: true,
      customer: { select: { name: true, email: true, phone: true } },
    },
  },
  product: { select: { externalRef: true, catalogProduct: { select: { ean: true } } } },
  location: { select: { currency: true, timezone: true, name: true } },
} satisfies Prisma.ProductReservationInclude;

type Candidate = Prisma.ProductReservationGetPayload<{ include: typeof candidateInclude }>;

/** What Base should know now: waiting, handed over or gone (taken back, expired, visit off). */
export const wantedState = (r: {
  status: string;
  appointment: { status: string };
}): BaseOrderState => {
  if (r.status === 'handed') return 'handed';
  if (r.status !== 'reserved' || !LIVE_STATUSES.has(r.appointment.status)) return 'cancelled';
  return 'reserved';
};

/**
 * Task Q4 (part 5): "Zamówienia do Base". When the seller turns it on, every product imported
 * from its Base that a client puts aside for a visit becomes an order in that Base ("odbiór w
 * salonie, płatność na miejscu", in the status the seller chose), so Base takes it off the stock
 * it also sells on Allegro, Empik or its own site. Handing the product over or the reservation
 * ending (taken back, expired, visit cancelled) moves the order to the chosen status.
 *
 * Sent right after a change on servers with background workers, and every 5 minutes by the
 * scheduler for anything that failed or changed elsewhere (a visit cancelled). A failing
 * reservation is tried at most MAX_ORDER_FAILS times; "Synchronizuj teraz" tries again.
 * Every round that sent something is in the seller's log ("orders").
 */
@Injectable()
export class BaseOrdersService {
  private readonly logger = new Logger('BaseOrders');
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly base: BaseApi,
    private readonly box: SecretBox,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** After a reservation changed: send it soon, without making the client wait (not in tests). */
  soon(locationId: string): void {
    if (this.config.OUTBOX_POLL_MS <= 0) return;
    setImmediate(() => {
      this.pushForLocation(locationId).catch((error: unknown) =>
        this.logger.error(`Failed: ${error instanceof Error ? error.message : error}`),
      );
    });
  }

  /** The scheduler: every salon with orders to Base turned on. Returns how many sent something. */
  async pushDue(): Promise<number> {
    const integrations = await this.prisma.shopIntegration.findMany({
      where: { provider: 'base', ordersEnabled: true, inventoryId: { not: null } },
    });
    let sent = 0;
    for (const integration of integrations) {
      if ((await this.push(integration)) > 0) sent += 1;
    }
    return sent;
  }

  async pushForLocation(locationId: string): Promise<number> {
    const integration = await this.prisma.shopIntegration.findUnique({
      where: { locationId_provider: { locationId, provider: 'base' } },
    });
    return integration ? this.push(integration) : 0;
  }

  /** "Synchronizuj teraz": reservations that stopped after failing get another chance. */
  async retryFailed(locationId: string): Promise<void> {
    await this.prisma.productReservation.updateMany({
      where: { locationId, baseOrderFails: { gte: MAX_ORDER_FAILS } },
      data: { baseOrderFails: 0 },
    });
  }

  /** Reservations whose order could not be sent (shown in "Integracje"). */
  failing(locationId: string): Promise<number> {
    return this.prisma.productReservation.count({
      where: { locationId, baseOrderFails: { gt: 0 } },
    });
  }

  /**
   * Sends what Base does not know yet: new orders for waiting reservations, and status changes
   * for orders already sent. Returns how many calls went through. Never throws for Base errors:
   * they are kept on the reservation and in the log.
   */
  async push(integration: ShopIntegration): Promise<number> {
    if (!integration.ordersEnabled || !integration.inventoryId || !integration.orderStatusNewId) {
      return 0;
    }
    if (this.running.has(integration.id)) return 0;
    this.running.add(integration.id);
    try {
      return await this.pushOnce(integration, integration.inventoryId);
    } finally {
      this.running.delete(integration.id);
    }
  }

  private async pushOnce(integration: ShopIntegration, inventoryId: string): Promise<number> {
    const prefix = `base:${inventoryId}:`;
    const rows = await this.prisma.productReservation.findMany({
      where: {
        locationId: integration.locationId,
        baseOrderFails: { lt: MAX_ORDER_FAILS },
        product: { externalRef: { startsWith: prefix } },
        OR: [
          { baseOrderId: null, status: 'reserved', appointment: { status: 'confirmed' } },
          // Task 606: an addOrder whose answer never came back, on a reservation that ended
          // meanwhile — the order may be in Base and must be found and cancelled there.
          { baseOrderId: null, baseOrderState: SENDING },
          { baseOrderId: { not: null }, baseOrderState: 'reserved' },
        ],
      },
      include: candidateInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
    });
    const work = rows.filter((r) => r.baseOrderId === null || wantedState(r) !== 'reserved');
    if (work.length === 0) return 0;

    const run = await this.prisma.shopSyncRun.create({
      data: { integrationId: integration.id, trigger: 'orders', checked: work.length },
    });
    let changed = 0;
    let firstError: unknown;
    const token = this.box.open(integration.tokenCiphertext);
    for (const r of work) {
      try {
        if (!token) throw new Error('Paste the Base API token again');
        await this.send(integration, token, prefix, r);
        changed += 1;
      } catch (error: unknown) {
        firstError ??= error;
        await this.prisma.productReservation.update({
          where: { id: r.id },
          data: {
            baseOrderFails: { increment: 1 },
            baseOrderError: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          },
        });
      }
    }
    await closeRun(this.prisma, run.id, { checked: work.length, changed }, firstError);
    return changed;
  }

  private async send(
    integration: ShopIntegration,
    token: string,
    prefix: string,
    r: Candidate,
  ): Promise<void> {
    const wanted = wantedState(r);
    let orderId = r.baseOrderId;
    if (orderId === null) {
      // Task 606: an earlier attempt may have reached Base without us learning its answer (a
      // timeout, a crash between addOrder and writing the id down). Ask Base before adding the
      // order again, so a reservation never becomes two orders.
      const maybeInBase = r.baseOrderState === SENDING || r.baseOrderFails > 0;
      const found = maybeInBase
        ? await this.base.findOrder(
            token,
            r.id,
            new Date(r.createdAt.getTime() - 60_000),
            r.appointment.customer?.email ?? null,
          )
        : null;
      if (found) {
        orderId = found;
        await this.prisma.productReservation.update({
          where: { id: r.id },
          data: {
            baseOrderId: found,
            baseOrderState: 'reserved',
            baseOrderFails: 0,
            baseOrderError: null,
          },
        });
      } else if (wanted !== 'reserved') {
        // Nothing reached Base and the reservation is over: there is nothing to send.
        await this.prisma.productReservation.update({
          where: { id: r.id },
          data: { baseOrderState: null, baseOrderFails: 0, baseOrderError: null },
        });
        return;
      }
    }
    if (orderId === null) {
      await this.prisma.productReservation.update({
        where: { id: r.id },
        data: { baseOrderState: SENDING },
      });
      const added = await this.base.addOrder(token, {
        statusId: integration.orderStatusNewId as string,
        currency: r.location.currency,
        fullName: r.appointment.customer?.name ?? 'Klient salonu',
        email: r.appointment.customer?.email ?? null,
        phone: r.appointment.customer?.phone ?? null,
        comment: `Odbiór przy wizycie ${this.when(r)} · ${r.location.name} · Beauty Platform`,
        reference: r.id,
        product: {
          productId: r.product?.externalRef?.slice(prefix.length) ?? '',
          name: r.name,
          ean: r.product?.catalogProduct?.ean ?? null,
          price: r.unitPriceGrosze / 100,
          quantity: r.quantity,
          warehouseId: integration.warehouseId ?? '',
        },
      });
      await this.prisma.productReservation.update({
        where: { id: r.id },
        data: {
          baseOrderId: added,
          baseOrderState: 'reserved',
          baseOrderFails: 0,
          baseOrderError: null,
        },
      });
      return;
    }
    if (wanted === 'reserved') return;
    const statusId =
      wanted === 'handed' ? integration.orderStatusHandedId : integration.orderStatusCancelledId;
    // No status chosen for this end: nothing to tell Base, the seller handles it there.
    if (statusId) await this.base.setOrderStatus(token, orderId, statusId);
    await this.prisma.productReservation.update({
      where: { id: r.id },
      data: { baseOrderState: wanted, baseOrderFails: 0, baseOrderError: null },
    });
  }

  /** "21.11.2026 14:00" in the salon's time. */
  private when(r: Candidate): string {
    return new Intl.DateTimeFormat('pl-PL', {
      timeZone: r.location.timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
      .format(r.appointment.startAt)
      .replace(',', '');
  }
}
