import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { Product } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { instantToLocal } from '../scheduling/time';
import { AppointmentsService } from './appointments.service';
import { stockCsv } from './stock-csv';
import type { CsvLocale } from '../reports/visits-csv';
import type {
  AddProductSaleInput,
  CreateProductInput,
  ProductListResponse,
  ProductResponse,
  UpdateProductInput,
  VisitProductSalesResponse,
} from './products.schemas';

const toProduct = (p: Product): ProductResponse => ({
  id: p.id,
  name: p.name,
  priceGrosze: p.priceGrosze,
  active: p.active,
  stockQuantity: p.stockQuantity,
  lowStockAt: p.lowStockAt,
  lowStock: p.stockQuantity !== null && p.lowStockAt !== null && p.stockQuantity <= p.lowStockAt,
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
    return { products: products.map(toProduct) };
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
      csv: stockCsv(products.map(toProduct), locale),
      fileName: `stock-${location.slug}-${day}.csv`,
    };
  }

  async create(
    m: MembershipContext,
    locationId: string,
    input: CreateProductInput,
  ): Promise<ProductResponse> {
    await this.access.writable(m, locationId);
    return toProduct(await this.prisma.product.create({ data: { ...input, locationId } }));
  }

  async update(
    m: MembershipContext,
    locationId: string,
    productId: string,
    input: UpdateProductInput,
  ): Promise<ProductResponse> {
    await this.access.writable(m, locationId);
    const result = await this.prisma.product.updateMany({
      where: { id: productId, locationId },
      data: input,
    });
    if (result.count !== 1) throw notFound('Product');
    return toProduct(await this.prisma.product.findUniqueOrThrow({ where: { id: productId } }));
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
      }
      await tx.productSale.create({
        data: {
          locationId,
          appointmentId,
          productId: product.id,
          name: product.name,
          quantity: input.quantity,
          unitPriceGrosze: product.priceGrosze,
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
        await tx.product.updateMany({
          where: { id: sale.productId, stockQuantity: { not: null } },
          data: { stockQuantity: { increment: sale.quantity } },
        });
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
