import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { Product } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppointmentsService } from './appointments.service';
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
});

/**
 * Task 394: "Produkty" — the salon's own list of products (pomade, shampoo…) and the ones sold
 * at a visit. A sale keeps the name and the price of that moment. Sales are not part of the
 * visit price, the loyalty points or the discounts; no stock and no payment systems.
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
    await this.prisma.productSale.create({
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
    const result = await this.prisma.productSale.deleteMany({
      where: { id: saleId, appointmentId, locationId },
    });
    if (result.count !== 1) throw notFound('Product sale');
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
