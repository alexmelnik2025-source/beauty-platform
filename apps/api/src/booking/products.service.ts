import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { Prisma, Product, StockMovementKind } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { instantToLocal } from '../scheduling/time';
import { AppointmentsService } from './appointments.service';
import { stockCsv } from './stock-csv';
import type { CsvLocale } from '../reports/visits-csv';
import type {
  AddProductSaleInput,
  CreateProductInput,
  RestockProductInput,
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
});

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
 * Task 448: "Cena zakupu" — owners and managers may write what the salon pays for one; a sale keeps
 * it (like the sale price) for the margin in the report. Specialists never see it.
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
    const purchasePrice = seesPurchasePrice(m);
    return { products: products.map((p) => toProduct(p, purchasePrice)) };
  }

  /** Task 436: the list as a CSV for ordering from the supplier (owners and managers). */
  async stockCsv(
    m: MembershipContext,
    locationId: string,
    locale: CsvLocale,
  ): Promise<{ csv: string; fileName: string }> {
    const location = await this.access.writable(m, locationId);
    const products = await this.prisma.product.findMany({
      where: { locationId },
      orderBy: [{ active: 'desc' }, { name: 'asc' }, { id: 'asc' }],
    });
    const day = instantToLocal(Date.now(), location.timezone).date;
    return {
      csv: stockCsv(
        products.map((p) => toProduct(p)),
        locale,
      ),
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
      await this.prisma.$transaction(async (tx) => {
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
      await this.prisma.$transaction(async (tx) => {
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
