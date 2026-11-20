import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ProductsService } from '../booking/products.service';
import { PublicBookingService } from '../booking/public-booking.service';
import { AppException, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { Appointment, Location, Prisma, ProductReservation } from '../generated/prisma/client';
import { AppointmentsService } from '../booking/appointments.service';
import { PrismaService } from '../prisma/prisma.service';
import { BaseOrdersService } from './integrations/base-orders.service';
import { instantToLocal } from '../scheduling/time';
import type {
  ReserveProductInput,
  UsedProductsResponse,
  VisitProductsResponse,
  VisitReservationsResponse,
} from './shop.schemas';

/** A visit that still counts: its reservations hold pieces for the client. */
const LIVE_VISIT: Prisma.AppointmentWhereInput = { status: { in: ['confirmed', 'completed'] } };

/** Reservations that still hold pieces: waiting, on a visit that still counts. */
export const holdingWhere = (productId: string): Prisma.ProductReservationWhereInput => ({
  productId,
  status: 'reserved',
  appointment: LIVE_VISIT,
});

const tooLate = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'TOO_LATE_TO_CHANGE',
    'Products can be put aside or taken back only for a confirmed visit that has not started',
  );

const notAvailable = (left: number): AppException =>
  new AppException(HttpStatus.CONFLICT, 'OUT_OF_STOCK', `Only ${left} left to put aside`);

const noNextVisit = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'NO_NEXT_VISIT',
    'The client has no next visit booked in this salon',
  );

const notReserved = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'NOT_RESERVED',
    'This product is no longer waiting for the client',
  );

type ReservationRow = ProductReservation & {
  product: { catalogProduct: { photo: { id: string } | null } | null } | null;
};

const reservationInclude = {
  product: { select: { catalogProduct: { select: { photo: { select: { id: true } } } } } },
} satisfies Prisma.ProductReservationInclude;

const toReservation = (r: ReservationRow) => ({
  id: r.id,
  productId: r.productId,
  name: r.name,
  quantity: r.quantity,
  unitPriceGrosze: r.unitPriceGrosze,
  totalGrosze: r.quantity * r.unitPriceGrosze,
  status: r.status,
  photoId: r.product?.catalogProduct?.photo?.id ?? null,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Task Q3 (part 4): "Odbiorę przy wizycie" — a product the client puts aside for a visit and
 * picks up and pays for at the salon (no online payment). The reservation keeps the name and the
 * price of that moment. While it waits on a live visit it is taken from what clients see as
 * available (`stock − reserved`); the stock itself changes only when the salon hands the product
 * over, which makes the usual sale at the visit (task 394) and marks the reservation `handed`.
 * A cancelled visit frees the pieces by itself (its reservations no longer count); the client may
 * take a product back until the visit starts.
 */
@Injectable()
export class ReservationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReservationsService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly booking: PublicBookingService,
    private readonly appointments: AppointmentsService,
    private readonly products: ProductsService,
    private readonly baseOrders: BaseOrdersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Once an hour, like the other housekeeping timers; off where the outbox timer is off (tests). */
  onModuleInit(): void {
    if (this.config.OUTBOX_POLL_MS > 0) {
      this.timer = setInterval(() => void this.tick(), 60 * 60_000);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      const expired = await this.expireOverdue();
      if (expired > 0) this.logger.log(`Expired ${expired} product reservations not picked up`);
    } catch (error) {
      this.logger.error(`Expiry failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** How many pieces clients may still put aside: stock minus what waits on live visits. */
  async availableToReserve(
    productId: string,
    stockQuantity: number | null,
  ): Promise<number | null> {
    if (stockQuantity === null) return null;
    const held = await this.prisma.productReservation.aggregate({
      where: holdingWhere(productId),
      _sum: { quantity: true },
    });
    return Math.max(0, stockQuantity - (held._sum.quantity ?? 0));
  }

  /** Pieces waiting on live visits, by product — for many products at once. */
  async heldByProduct(productIds: string[]): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const held = await this.prisma.productReservation.groupBy({
      by: ['productId'],
      where: { productId: { in: productIds }, status: 'reserved', appointment: LIVE_VISIT },
      _sum: { quantity: true },
    });
    return new Map(
      held
        .filter((h) => h.productId !== null)
        .map((h) => [h.productId as string, h._sum.quantity ?? 0]),
    );
  }

  // ── The client, by the visit link ───────────────────────

  async byToken(token: string): Promise<VisitProductsResponse> {
    const visit = await this.booking.appointmentByToken(token);
    return this.forClient(visit, visit.location);
  }

  async reserveByToken(token: string, input: ReserveProductInput): Promise<VisitProductsResponse> {
    const visit = await this.booking.appointmentByToken(token);
    await this.reserve(visit, visit.location, input);
    return this.forClient(visit, visit.location);
  }

  async cancelByToken(token: string, reservationId: string): Promise<VisitProductsResponse> {
    const visit = await this.booking.appointmentByToken(token);
    await this.cancelByClient(visit, reservationId);
    return this.forClient(visit, visit.location);
  }

  // ── Screen C: after the visit, "Odłóż na następną wizytę" ──

  async usedByToken(token: string): Promise<UsedProductsResponse> {
    const visit = await this.booking.appointmentByToken(token);
    return this.used(visit, visit.location);
  }

  async reserveForNextByToken(
    token: string,
    input: ReserveProductInput,
  ): Promise<UsedProductsResponse> {
    const visit = await this.booking.appointmentByToken(token);
    await this.reserveForNext(visit, visit.location, input);
    return this.used(visit, visit.location);
  }

  /**
   * The client's next visit in the same salon: confirmed and still ahead, the earliest one.
   * Visits are the client's by their salon card (`customerId`); without one there is none.
   */
  private async nextVisit(visit: Appointment) {
    if (!visit.customerId) return null;
    return this.prisma.appointment.findFirst({
      where: {
        locationId: visit.locationId,
        customerId: visit.customerId,
        status: 'confirmed',
        startAt: { gt: new Date() },
        id: { not: visit.id },
      },
      include: { staff: { select: { displayName: true } } },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Task Q3 (screen C): "{specialist} used on you:" — products sold at this visit (the salon's
   * own sale at the visit, so only once the client came) that the salon still shows to clients,
   * with the current price; and the client's next visit to put them aside for.
   */
  async used(
    visit: Appointment,
    location: Pick<Location, 'id' | 'currency' | 'timezone'>,
  ): Promise<UsedProductsResponse> {
    const sales = await this.prisma.productSale.findMany({
      where: { appointmentId: visit.id, productId: { not: null } },
      select: { productId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const ids = Array.from(new Set(sales.map((s) => s.productId as string)));
    const rows = ids.length
      ? await this.prisma.product.findMany({
          where: { id: { in: ids }, locationId: location.id, active: true, inSalonShop: true },
          include: { catalogProduct: { select: { brand: true, photo: { select: { id: true } } } } },
        })
      : [];
    const byId = new Map(rows.map((p) => [p.id, p]));
    const next = rows.length ? await this.nextVisit(visit) : null;
    const waiting = next
      ? await this.prisma.productReservation.findMany({
          where: { appointmentId: next.id, status: 'reserved' },
          select: { productId: true },
        })
      : [];
    const waitingIds = new Set(waiting.map((r) => r.productId));
    const products = await Promise.all(
      ids
        .map((id) => byId.get(id))
        .filter((p): p is NonNullable<typeof p> => p !== undefined)
        .map(async (p) => ({
          id: p.id,
          name: p.name,
          brand: p.catalogProduct?.brand ?? null,
          priceGrosze: p.priceGrosze,
          photoId: p.catalogProduct?.photo?.id ?? null,
          available: ((await this.availableToReserve(p.id, p.stockQuantity)) ?? 1) > 0,
          reservedForNext: waitingIds.has(p.id),
        })),
    );
    const local = next ? instantToLocal(next.startAt.getTime(), location.timezone) : null;
    return {
      currency: location.currency,
      products,
      nextVisit:
        next && local
          ? { date: local.date, time: local.time, staffName: next.staff.displayName }
          : null,
      rebook: { serviceId: visit.serviceId, staffId: visit.staffId },
    };
  }

  /** "Odłóż na następną wizytę": the same as putting it aside on the next visit itself. */
  async reserveForNext(
    visit: Appointment,
    location: Pick<Location, 'id'>,
    input: ReserveProductInput,
  ): Promise<void> {
    const used = await this.prisma.productSale.findFirst({
      where: { appointmentId: visit.id, productId: input.productId },
      select: { id: true },
    });
    if (!used) throw notFound('Product');
    const next = await this.nextVisit(visit);
    if (!next) throw noNextVisit();
    // A second tap (or a retry) does not put a second piece aside.
    const already = await this.prisma.productReservation.findFirst({
      where: { appointmentId: next.id, productId: input.productId, status: 'reserved' },
      select: { id: true },
    });
    if (already) return;
    await this.reserve(next, location, input);
  }

  /** The same for the client app ("Moje wizyty"); the caller checked the visit is theirs. */
  async forClient(
    visit: Appointment,
    location: Pick<Location, 'id' | 'currency' | 'onlineBookingEnabled'>,
  ): Promise<VisitProductsResponse> {
    const canChange = this.canChange(visit);
    const rows = await this.prisma.productReservation.findMany({
      where: { appointmentId: visit.id, status: { not: 'cancelled' } },
      include: reservationInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const products = canChange
      ? await this.prisma.product.findMany({
          where: { locationId: location.id, active: true, inSalonShop: true },
          include: { catalogProduct: { select: { brand: true, photo: { select: { id: true } } } } },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        })
      : [];
    const available = await Promise.all(
      products.map(async (p) => ({
        id: p.id,
        name: p.name,
        brand: p.catalogProduct?.brand ?? null,
        priceGrosze: p.priceGrosze,
        photoId: p.catalogProduct?.photo?.id ?? null,
        available: ((await this.availableToReserve(p.id, p.stockQuantity)) ?? 1) > 0,
      })),
    );
    return {
      currency: location.currency,
      canChange,
      reservations: rows.map(toReservation),
      totalGrosze: rows
        .filter((r) => r.status === 'reserved' || r.status === 'handed')
        .reduce((sum, r) => sum + r.quantity * r.unitPriceGrosze, 0),
      available,
    };
  }

  /** Until the visit starts, and only on a confirmed one. */
  private canChange(visit: Appointment): boolean {
    return visit.status === 'confirmed' && visit.startAt.getTime() > Date.now();
  }

  async reserve(
    visit: Appointment,
    location: Pick<Location, 'id'>,
    input: ReserveProductInput,
  ): Promise<ProductReservation> {
    if (!this.canChange(visit)) throw tooLate();
    const product = await this.prisma.product.findFirst({
      where: { id: input.productId, locationId: location.id, active: true, inSalonShop: true },
    });
    if (!product) throw notFound('Product');
    const reservation = await this.prisma.$transaction(async (tx) => {
      // Lock the product row so two clients cannot both take the last piece.
      await tx.$queryRaw`SELECT id FROM product WHERE id = ${product.id}::uuid FOR UPDATE`;
      if (product.stockQuantity !== null) {
        const held = await tx.productReservation.aggregate({
          where: holdingWhere(product.id),
          _sum: { quantity: true },
        });
        const left = product.stockQuantity - (held._sum.quantity ?? 0);
        if (left < input.quantity) throw notAvailable(Math.max(0, left));
      }
      return tx.productReservation.create({
        data: {
          locationId: location.id,
          appointmentId: visit.id,
          productId: product.id,
          name: product.name,
          quantity: input.quantity,
          unitPriceGrosze: product.priceGrosze,
        },
      });
    });
    this.baseOrders.soon(location.id);
    return reservation;
  }

  async cancelByClient(visit: Appointment, reservationId: string): Promise<void> {
    if (!this.canChange(visit)) throw tooLate();
    const result = await this.prisma.productReservation.updateMany({
      where: { id: reservationId, appointmentId: visit.id, status: 'reserved' },
      data: { status: 'cancelled' },
    });
    if (result.count !== 1) throw notFound('Reservation');
    this.baseOrders.soon(visit.locationId);
  }

  // ── The salon, in the visit card ────────────────────────

  async forVisit(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
  ): Promise<VisitReservationsResponse> {
    await this.appointments.visible(m, userId, locationId, appointmentId);
    const rows = await this.prisma.productReservation.findMany({
      where: { appointmentId, locationId },
      include: reservationInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return {
      reservations: rows.map(toReservation),
      toHandGrosze: rows
        .filter((r) => r.status === 'reserved')
        .reduce((sum, r) => sum + r.quantity * r.unitPriceGrosze, 0),
    };
  }

  /**
   * "Rozlicz wizytę i produkt": the product is handed to the client — the usual sale at the visit
   * (task 394: the visit must be marked "came", the pieces leave the stock, the price is the
   * product's now) and the reservation is marked `handed` with that sale.
   */
  async handOver(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
    reservationId: string,
  ): Promise<VisitReservationsResponse> {
    const reservation = await this.prisma.productReservation.findFirst({
      where: { id: reservationId, appointmentId, locationId },
    });
    if (!reservation) throw notFound('Reservation');
    if (reservation.status !== 'reserved') throw notReserved();
    if (!reservation.productId) throw notFound('Product');
    const before = await this.prisma.productSale.findMany({
      where: { appointmentId },
      select: { id: true },
    });
    await this.products.addSale(m, userId, locationId, appointmentId, {
      productId: reservation.productId,
      quantity: reservation.quantity,
    });
    const sale = await this.prisma.productSale.findFirst({
      where: { appointmentId, id: { notIn: before.map((s) => s.id) } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    await this.prisma.productReservation.update({
      where: { id: reservationId },
      data: { status: 'handed', saleId: sale?.id ?? null },
    });
    this.baseOrders.soon(locationId);
    return this.forVisit(m, userId, locationId, appointmentId);
  }

  /** The salon takes a waiting product back (the client changed their mind at the visit). */
  async cancelBySalon(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
    reservationId: string,
  ): Promise<VisitReservationsResponse> {
    await this.appointments.changeable(m, userId, locationId, appointmentId);
    const result = await this.prisma.productReservation.updateMany({
      where: { id: reservationId, appointmentId, locationId, status: 'reserved' },
      data: { status: 'cancelled' },
    });
    if (result.count !== 1) throw notReserved();
    this.baseOrders.soon(locationId);
    return this.forVisit(m, userId, locationId, appointmentId);
  }

  /**
   * Reservations not picked up within the salon's days after the visit expire, so the pieces are
   * free again. Run by the outbox timer (and by tests) — idempotent.
   */
  async expireOverdue(now = new Date()): Promise<number> {
    const waiting = await this.prisma.productReservation.findMany({
      where: { status: 'reserved', appointment: { startAt: { lt: now } } },
      select: {
        id: true,
        appointment: { select: { startAt: true } },
        location: { select: { shopReservationDays: true } },
      },
    });
    const DAY = 24 * 60 * 60 * 1000;
    const overdue = waiting
      .filter(
        (r) =>
          r.appointment.startAt.getTime() + r.location.shopReservationDays * DAY <= now.getTime(),
      )
      .map((r) => r.id);
    if (overdue.length === 0) return 0;
    const result = await this.prisma.productReservation.updateMany({
      where: { id: { in: overdue }, status: 'reserved' },
      data: { status: 'expired' },
    });
    return result.count;
  }
}
