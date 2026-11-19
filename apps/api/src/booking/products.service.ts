import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { Prisma, Product, StockMovementKind } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { instantToLocal } from '../scheduling/time';
import { AppointmentsService } from './appointments.service';
import { stockCsv, toOrder } from './stock-csv';
import type { CsvLocale } from '../reports/visits-csv';
import type {
  AddProductSaleInput,
  CreateProductInput,
  DeliveryInput,
  DeliveryResponse,
  RestockProductInput,
  StocktakeInput,
  StocktakeResponse,
  WriteOffProductInput,
  StockHistoryResponse,
  ProductListResponse,
  ProductResponse,
  UpdateProductInput,
  VisitProductSalesResponse,
} from './products.schemas';

/** The most pieces a product may have in stock (as in the product form). */
const MAX_STOCK = 100_000;

/** Task 440: writes down one change of the pieces in stock. */
function movement(
  tx: Prisma.TransactionClient,
  productId: string,
  kind: StockMovementKind,
  change: number,
  quantityAfter: number | null,
  userId: string,
  note: string | null = null,
) {
  return tx.stockMovement.create({
    data: { productId, kind, change, quantityAfter, createdByUserId: userId, note },
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Task 448: only owners and managers see what the salon pays for its products. */
const seesPurchasePrice = (m: MembershipContext) => m.role !== 'staff';

const toProduct = (p: Product, purchasePrice = true): ProductResponse => ({
  id: p.id,
  name: p.name,
  priceGrosze: p.priceGrosze,
  active: p.active,
  stockQuantity: p.stockQuantity,
  lowStockAt: p.lowStockAt,
  lowStock: p.stockQuantity !== null && p.lowStockAt !== null && p.stockQuantity <= p.lowStockAt,
  purchasePriceGrosze: purchasePrice ? p.purchasePriceGrosze : null,
  supplier: p.supplier,
  barcode: p.barcode,
});

/** Task 520: another product of the salon already has this code. */
const barcodeTaken = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'BARCODE_TAKEN',
    'Another product of the salon has this barcode',
  );

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';

/**
 * Task 394: "Produkty" — the salon's own list of products (pomade, shampoo…) and the ones sold
 * at a visit. A sale keeps the name and the price of that moment. Sales are not part of the
 * visit price, the loyalty points or the discounts; no payment systems.
 *
 * Task 429: a product may count its pieces in stock (`stockQuantity`, null = not counted). A sale
 * takes them away — more than there are is refused (409 OUT_OF_STOCK) — and removing a sale puts
 * them back, both in one transaction with the sale.
 *
 * Task 438: "Dostawa" adds the pieces that arrived to what is in stock in one step, so the owner
 * does not count by hand (and a sale at the same moment is not lost); a product that did not count
 * its pieces starts counting with them.
 *
 * Task 440: every change of the pieces in stock is written down ("Historia magazynu"): a sale, a
 * sale removed, a delivery, a number written by hand — with who and when, in the same transaction.
 *
 * Task 456: "Inwentaryzacja" — the owner counts what is on the shelf and writes the numbers for many
 * products at once; each number that differs is written down as a "stocktake" movement, so the
 * history shows what was missing or extra (a product that did not count its pieces only starts
 * counting: a "correction", as when the number is written by hand). The products are locked while they are changed, so a
 * sale at the same moment is counted before or after, never lost.
 *
 * Task 448: "Cena zakupu" — owners and managers may write what the salon pays for one; a sale keeps
 * it (like the sale price) for the margin in the report. Specialists never see it.
 *
 * Task 462: "Dostawca" — whom the salon orders the product from (free text, everyone in the salon
 * sees it); the stock CSV may be made for one supplier only.
 *
 * Task 520: "Kod kreskowy" — the code on the package, so a product is found by scanning or typing
 * it; one product per code in a salon (409 BARCODE_TAKEN), everyone in the salon sees it.
 *
 * Task 433: with `lowStockAt` the product says "Kończy się" (`lowStock`) once that many pieces or
 * fewer are left, so the owner orders more in time.
 *
 * The list: everyone in the salon reads it (to note a sale), owners and managers change it.
 * Sales: whoever may change the visit (own visits with "changeOwnAppointments", others' with
 * "manageAllAppointments"), and only on a visit that took place.
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
    private readonly appointments: AppointmentsService,
  ) {}

  async list(m: MembershipContext, locationId: string): Promise<ProductListResponse> {
    await this.access.readable(m, locationId);
    const products = await this.prisma.product.findMany({
      where: { locationId },
      orderBy: [{ active: 'desc' }, { name: 'asc' }, { id: 'asc' }],
    });
    const sold = await this.sold30Days(locationId);
    return {
      products: products.map((p) => toProduct(p, seesPurchasePrice(m))),
      sold30Days: [...sold]
        .map(([productId, quantity]) => ({ productId, quantity }))
        .sort((a, b) => a.productId.localeCompare(b.productId)),
    };
  }

  /** Task 461: how fast each product sells — pieces sold at the visits of the last 30 days, up to now. */
  private async sold30Days(locationId: string): Promise<Map<string, number>> {
    const now = new Date();
    const sold = await this.prisma.productSale.groupBy({
      by: ['productId'],
      where: {
        locationId,
        productId: { not: null },
        appointment: { startAt: { gte: new Date(now.getTime() - 30 * DAY_MS), lte: now } },
      },
      _sum: { quantity: true },
    });
    const out = new Map<string, number>();
    for (const s of sold) {
      if (s.productId !== null && (s._sum.quantity ?? 0) > 0) {
        out.set(s.productId, s._sum.quantity ?? 0);
      }
    }
    return out;
  }

  /**
   * Task 436: the list as a CSV for ordering from the supplier (owners and managers).
   * Task 462: with `supplier`, only that supplier's products (any letter case).
   * Task 469: with `onlyToOrder`, only the products to order; each line says how many were sold in
   * the last 30 days.
   */
  async stockCsv(
    m: MembershipContext,
    locationId: string,
    locale: CsvLocale,
    supplier?: string,
    onlyToOrder = false,
  ): Promise<{ csv: string; fileName: string }> {
    const location = await this.access.writable(m, locationId);
    const products = await this.prisma.product.findMany({
      where: {
        locationId,
        ...(supplier ? { supplier: { equals: supplier, mode: 'insensitive' as const } } : {}),
      },
      orderBy: [{ active: 'desc' }, { name: 'asc' }, { id: 'asc' }],
    });
    const day = instantToLocal(Date.now(), location.timezone).date;
    const sold = await this.sold30Days(locationId);
    const lines = products
      .map((p) => ({ ...toProduct(p), sold30Days: sold.get(p.id) ?? 0 }))
      .filter((l) => !onlyToOrder || toOrder(l));
    return {
      csv: stockCsv(lines, locale),
      fileName: `stock-${location.slug}-${day}.csv`,
    };
  }

  async create(
    m: MembershipContext,
    userId: string,
    locationId: string,
    input: CreateProductInput,
  ): Promise<ProductResponse> {
    await this.access.writable(m, locationId);
    return toProduct(
      await this.prisma
        .$transaction(async (tx) => {
          const product = await tx.product.create({ data: { ...input, locationId } });
          if (product.stockQuantity !== null && product.stockQuantity > 0) {
            await movement(
              tx,
              product.id,
              'correction',
              product.stockQuantity,
              product.stockQuantity,
              userId,
            );
          }
          return product;
        })
        .catch((error: unknown) => {
          throw isUniqueViolation(error) ? barcodeTaken() : error;
        }),
    );
  }

  async update(
    m: MembershipContext,
    userId: string,
    locationId: string,
    productId: string,
    input: UpdateProductInput,
  ): Promise<ProductResponse> {
    await this.access.writable(m, locationId);
    return toProduct(
      await this.prisma
        .$transaction(async (tx) => {
          const before = await tx.product.findFirst({ where: { id: productId, locationId } });
          if (!before) throw notFound('Product');
          const result = await tx.product.updateMany({
            where: { id: productId, locationId },
            data: input,
          });
          if (result.count !== 1) throw notFound('Product');
          const after = await tx.product.findUniqueOrThrow({ where: { id: productId } });
          // Task 440: a number written by hand (a sale at the same moment is its own movement).
          if (input.stockQuantity !== undefined && after.stockQuantity !== before.stockQuantity) {
            await movement(
              tx,
              productId,
              'correction',
              (after.stockQuantity ?? 0) - (before.stockQuantity ?? 0),
              after.stockQuantity,
              userId,
            );
          }
          return after;
        })
        .catch((error: unknown) => {
          throw isUniqueViolation(error) ? barcodeTaken() : error;
        }),
    );
  }

  async restock(
    m: MembershipContext,
    userId: string,
    locationId: string,
    productId: string,
    input: RestockProductInput,
  ): Promise<ProductResponse> {
    await this.access.writable(m, locationId);
    const product = await this.prisma.$transaction(async (tx) => {
      const added = await tx.product.updateMany({
        where: {
          id: productId,
          locationId,
          stockQuantity: { not: null, lte: MAX_STOCK - input.quantity },
        },
        data: { stockQuantity: { increment: input.quantity } },
      });
      if (added.count !== 1) {
        const started = await tx.product.updateMany({
          where: { id: productId, locationId, stockQuantity: null },
          data: { stockQuantity: input.quantity },
        });
        if (started.count !== 1) {
          const found = await tx.product.findFirst({ where: { id: productId, locationId } });
          if (!found) throw notFound('Product');
          throw new AppException(
            HttpStatus.CONFLICT,
            'STOCK_LIMIT',
            `At most ${MAX_STOCK} pieces in stock`,
          );
        }
      }
      const after = await tx.product.findUniqueOrThrow({ where: { id: productId } });
      await movement(tx, productId, 'delivery', input.quantity, after.stockQuantity, userId);
      return after;
    });
    return toProduct(product);
  }

  /** Task 456: "Inwentaryzacja" — the pieces counted on the shelf replace what was written. */
  async stocktake(
    m: MembershipContext,
    userId: string,
    locationId: string,
    input: StocktakeInput,
  ): Promise<StocktakeResponse> {
    await this.access.writable(m, locationId);
    const ids = input.counts.map((c) => c.productId);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM product WHERE id = ANY(${ids}::uuid[]) AND location_id = ${locationId}::uuid ORDER BY id FOR UPDATE`;
      const found = await tx.product.findMany({ where: { id: { in: ids }, locationId } });
      if (found.length !== ids.length) throw notFound('Product');
      const before = new Map(found.map((p) => [p.id, p.stockQuantity]));
      let changed = 0;
      let missingPieces = 0;
      let extraPieces = 0;
      for (const { productId, quantity } of input.counts) {
        const was = before.get(productId) ?? null;
        if (was === quantity) continue;
        await tx.product.update({ where: { id: productId }, data: { stockQuantity: quantity } });
        const change = quantity - (was ?? 0);
        // A product that did not count its pieces only starts counting: no difference to show.
        await movement(
          tx,
          productId,
          was === null ? 'correction' : 'stocktake',
          change,
          quantity,
          userId,
        );
        changed += 1;
        if (was !== null && change < 0) missingPieces -= change;
        if (was !== null && change > 0) extraPieces += change;
      }
      return { changed, missingPieces, extraPieces };
    });
    const { products } = await this.list(m, locationId);
    return { ...result, products };
  }

  /**
   * Task 475: "Przyjmij dostawę" — the pieces of the whole order added in one transaction, each
   * as a "delivery" in "Historia magazynu" (as task 438 for one product). The products are locked
   * while they are changed, so a sale at the same moment is counted before or after, never lost.
   * More than 100000 in stock for any of them → 409 STOCK_LIMIT and nothing is changed.
   */
  async delivery(
    m: MembershipContext,
    userId: string,
    locationId: string,
    input: DeliveryInput,
  ): Promise<DeliveryResponse> {
    await this.access.writable(m, locationId);
    const ids = input.items.map((c) => c.productId);
    let pieces = 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM product WHERE id = ANY(${ids}::uuid[]) AND location_id = ${locationId}::uuid ORDER BY id FOR UPDATE`;
      const found = await tx.product.findMany({ where: { id: { in: ids }, locationId } });
      if (found.length !== ids.length) throw notFound('Product');
      const before = new Map(found.map((p) => [p.id, p.stockQuantity]));
      for (const { productId, quantity } of input.items) {
        const after = (before.get(productId) ?? 0) + quantity;
        if (after > MAX_STOCK) {
          throw new AppException(
            HttpStatus.CONFLICT,
            'STOCK_LIMIT',
            `At most ${MAX_STOCK} pieces in stock`,
          );
        }
        await tx.product.update({ where: { id: productId }, data: { stockQuantity: after } });
        await movement(tx, productId, 'delivery', quantity, after, userId);
        pieces += quantity;
      }
    });
    const { products } = await this.list(m, locationId);
    return { products: input.items.length, pieces, list: products };
  }

  /** Task 443: "Odpis" — pieces used in the salon, damaged or lost, taken from the stock in one step. */
  async writeOff(
    m: MembershipContext,
    userId: string,
    locationId: string,
    productId: string,
    input: WriteOffProductInput,
  ): Promise<ProductResponse> {
    await this.access.writable(m, locationId);
    const product = await this.prisma.$transaction(async (tx) => {
      const taken = await tx.product.updateMany({
        where: { id: productId, locationId, stockQuantity: { gte: input.quantity } },
        data: { stockQuantity: { decrement: input.quantity } },
      });
      if (taken.count !== 1) {
        const found = await tx.product.findFirst({ where: { id: productId, locationId } });
        if (!found) throw notFound('Product');
        if (found.stockQuantity === null) {
          throw new AppException(
            HttpStatus.CONFLICT,
            'NOT_COUNTED',
            'The salon does not count the pieces of this product',
          );
        }
        throw new AppException(
          HttpStatus.CONFLICT,
          'OUT_OF_STOCK',
          `Only ${found.stockQuantity} in stock`,
        );
      }
      const after = await tx.product.findUniqueOrThrow({ where: { id: productId } });
      await movement(
        tx,
        productId,
        'write_off',
        -input.quantity,
        after.stockQuantity,
        userId,
        input.note || null,
      );
      return after;
    });
    return toProduct(product);
  }

  /** Task 440: "Historia magazynu" — the last 100 changes of the pieces in stock, newest first. */
  async stockHistory(
    m: MembershipContext,
    locationId: string,
    productId: string,
  ): Promise<StockHistoryResponse> {
    const location = await this.access.writable(m, locationId);
    const product = await this.prisma.product.findFirst({ where: { id: productId, locationId } });
    if (!product) throw notFound('Product');
    const rows = await this.prisma.stockMovement.findMany({
      where: { productId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    const userIds = [
      ...new Set(rows.flatMap((r) => (r.createdByUserId ? [r.createdByUserId] : []))),
    ];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const names = new Map(users.map((u) => [u.id, u.name]));
    return {
      movements: rows.map((r) => {
        const local = instantToLocal(r.createdAt.getTime(), location.timezone);
        return {
          id: r.id,
          kind: r.kind,
          change: r.change,
          quantityAfter: r.quantityAfter,
          at: r.createdAt.toISOString(),
          date: local.date,
          time: local.time,
          byName: (r.createdByUserId && names.get(r.createdByUserId)) || null,
          note: r.note,
        };
      }),
    };
  }

  /** Removes a product from the list; its past sales keep their name and price. */
  async remove(m: MembershipContext, locationId: string, productId: string): Promise<void> {
    await this.access.writable(m, locationId);
    const result = await this.prisma.product.deleteMany({ where: { id: productId, locationId } });
    if (result.count !== 1) throw notFound('Product');
  }

  async sales(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
  ): Promise<VisitProductSalesResponse> {
    await this.appointments.visible(m, userId, locationId, appointmentId);
    return this.view(appointmentId);
  }

  async addSale(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
    input: AddProductSaleInput,
  ): Promise<VisitProductSalesResponse> {
    const visit = await this.appointments.changeable(m, userId, locationId, appointmentId);
    if (visit.status !== 'completed') {
      throw new AppException(
        HttpStatus.CONFLICT,
        'NOT_COMPLETED',
        'Products can be sold only at a visit marked as "came"',
      );
    }
    const product = await this.prisma.product.findFirst({
      where: { id: input.productId, locationId, active: true },
    });
    if (!product) throw notFound('Product');
    await this.prisma.$transaction(async (tx) => {
      if (product.stockQuantity !== null) {
        // Only if there are enough pieces at this moment (a parallel sale may have taken some).
        const taken = await tx.product.updateMany({
          where: { id: product.id, stockQuantity: { gte: input.quantity } },
          data: { stockQuantity: { decrement: input.quantity } },
        });
        if (taken.count !== 1) {
          const left = await tx.product.findUnique({ where: { id: product.id } });
          throw new AppException(
            HttpStatus.CONFLICT,
            'OUT_OF_STOCK',
            `Only ${left?.stockQuantity ?? 0} in stock`,
          );
        }
        const left = await tx.product.findUniqueOrThrow({ where: { id: product.id } });
        await movement(tx, product.id, 'sale', -input.quantity, left.stockQuantity, userId);
      }
      await tx.productSale.create({
        data: {
          locationId,
          appointmentId,
          productId: product.id,
          name: product.name,
          quantity: input.quantity,
          unitPriceGrosze: product.priceGrosze,
          unitCostGrosze: product.purchasePriceGrosze,
          createdByUserId: userId,
        },
      });
    });
    return this.view(appointmentId);
  }

  async removeSale(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
    saleId: string,
  ): Promise<VisitProductSalesResponse> {
    await this.appointments.changeable(m, userId, locationId, appointmentId);
    await this.prisma.$transaction(async (tx) => {
      const sale = await tx.productSale.findFirst({
        where: { id: saleId, appointmentId, locationId },
      });
      const result = await tx.productSale.deleteMany({
        where: { id: saleId, appointmentId, locationId },
      });
      if (!sale || result.count !== 1) throw notFound('Product sale');
      // The pieces go back to stock if the product still counts them.
      if (sale.productId) {
        const back = await tx.product.updateMany({
          where: { id: sale.productId, stockQuantity: { not: null } },
          data: { stockQuantity: { increment: sale.quantity } },
        });
        if (back.count === 1) {
          const after = await tx.product.findUniqueOrThrow({ where: { id: sale.productId } });
          await movement(
            tx,
            sale.productId,
            'sale_removed',
            sale.quantity,
            after.stockQuantity,
            userId,
          );
        }
      }
    });
    return this.view(appointmentId);
  }

  private async view(appointmentId: string): Promise<VisitProductSalesResponse> {
    const sales = await this.prisma.productSale.findMany({
      where: { appointmentId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const rows = sales.map((s) => ({
      id: s.id,
      productId: s.productId,
      name: s.name,
      quantity: s.quantity,
      unitPriceGrosze: s.unitPriceGrosze,
      totalGrosze: s.quantity * s.unitPriceGrosze,
    }));
    return { sales: rows, totalGrosze: rows.reduce((sum, r) => sum + r.totalGrosze, 0) };
  }
}
