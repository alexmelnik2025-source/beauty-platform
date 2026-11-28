import type { Prisma, ProductReservation } from '../generated/prisma/client';

/** A visit that still counts: its reservations hold pieces for the client. */
export const LIVE_VISIT: Prisma.AppointmentWhereInput = {
  status: { in: ['confirmed', 'completed'] },
};

/** Reservations that still hold pieces: waiting, on a visit that still counts. */
export const holdingWhere = (productId: string): Prisma.ProductReservationWhereInput => ({
  productId,
  status: 'reserved',
  appointment: LIVE_VISIT,
});

interface Visit {
  id: string;
  locationId: string;
  customerId: string | null;
}

/**
 * Puts `quantity` pieces of a product aside for a visit, inside the caller's transaction. Locks
 * the product row so two clients cannot both take the last piece, and reads the stock and the
 * price again under the lock. Returns how many were left instead when that is not enough.
 * The caller checked the visit may still change and the product is one the salon shows to clients.
 */
export async function putAside(
  tx: Prisma.TransactionClient,
  visit: Visit,
  productId: string,
  quantity: number,
): Promise<{ reservation: ProductReservation } | { left: number }> {
  await tx.$queryRaw`SELECT id FROM product WHERE id = ${productId}::uuid FOR UPDATE`;
  const fresh = await tx.product.findUniqueOrThrow({
    where: { id: productId },
    select: { stockQuantity: true, priceGrosze: true, name: true },
  });
  if (fresh.stockQuantity !== null) {
    const held = await tx.productReservation.aggregate({
      where: holdingWhere(productId),
      _sum: { quantity: true },
    });
    const left = fresh.stockQuantity - (held._sum.quantity ?? 0);
    if (left < quantity) return { left: Math.max(0, left) };
  }
  const reservation = await tx.productReservation.create({
    data: {
      locationId: visit.locationId,
      appointmentId: visit.id,
      productId,
      name: fresh.name,
      quantity,
      unitPriceGrosze: fresh.priceGrosze,
    },
  });
  if (visit.customerId) {
    // "Przenieść produkty na nowy termin?": the same product waiting on a cancelled visit of this
    // client is now moved here — the old reservation is settled, so neither the client's old
    // visit page nor the salon's card of the cancelled visit offers it again (task 605).
    await tx.productReservation.updateMany({
      where: {
        productId,
        status: 'reserved',
        appointment: {
          id: { not: visit.id },
          locationId: visit.locationId,
          customerId: visit.customerId,
          status: 'cancelled',
        },
      },
      data: { status: 'cancelled' },
    });
    // Audit EJ fix: "Odłóż na następną wizytę" chosen before this visit was booked is done now.
    await tx.nextVisitProduct.deleteMany({
      where: {
        productId,
        appointment: { locationId: visit.locationId, customerId: visit.customerId },
      },
    });
  }
  return { reservation };
}

/**
 * Audit EJ fix (28.11.2026): a visit was just booked — what the client chose "Odłóż na następną
 * wizytę" for on an earlier visit in this salon, while they had no next one, is put aside for this
 * visit now (once each). A product sold out meanwhile, hidden from clients or no longer sold keeps
 * waiting (the earlier visit's page shows it unavailable). Never fails the booking.
 */
export async function moveChosenToVisit(
  tx: Prisma.TransactionClient,
  visit: Visit & { status: string; startAt: Date },
): Promise<number> {
  if (!visit.customerId || visit.status !== 'confirmed' || visit.startAt.getTime() <= Date.now()) {
    return 0;
  }
  const chosen = await tx.nextVisitProduct.findMany({
    where: {
      appointment: { locationId: visit.locationId, customerId: visit.customerId },
      product: { locationId: visit.locationId, active: true, inSalonShop: true },
    },
    select: { productId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  let moved = 0;
  for (const productId of new Set(chosen.map((c) => c.productId))) {
    const waiting = await tx.productReservation.count({
      where: { appointmentId: visit.id, productId, status: 'reserved' },
    });
    if (waiting > 0) {
      await tx.nextVisitProduct.deleteMany({
        where: {
          productId,
          appointment: { locationId: visit.locationId, customerId: visit.customerId },
        },
      });
      continue;
    }
    const result = await putAside(tx, visit, productId, 1);
    if ('reservation' in result) moved += 1;
  }
  return moved;
}
