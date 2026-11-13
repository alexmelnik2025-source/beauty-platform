import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentAuth } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import type { AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../organizations/membership.guard';
import {
  addProductSaleSchema,
  createProductSchema,
  productListSchema,
  productSchema,
  updateProductSchema,
  visitProductSalesSchema,
  type AddProductSaleInput,
  type CreateProductInput,
  type ProductListResponse,
  type ProductResponse,
  type UpdateProductInput,
  type VisitProductSalesResponse,
} from './products.schemas';
import { ProductsService } from './products.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

/** Task 394: the salon's products and the ones sold at a visit. */
@ApiTags('products')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId')
@UseGuards(MembershipGuard)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get('products')
  @ApiOperation({ summary: "The salon's products (everyone in the salon)" })
  @ApiZodResponse(productListSchema)
  list(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<ProductListResponse> {
    return this.products.list(m, locationId);
  }

  @Post('products')
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'Add a product to the list' })
  @ApiZodBody(createProductSchema)
  @ApiZodResponse(productSchema, HttpStatus.CREATED)
  create(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
  ): Promise<ProductResponse> {
    return this.products.create(m, locationId, body);
  }

  @Patch('products/:productId')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Change a product (name, price, sold or not)',
    description: 'Past sales keep the name and price they had.',
  })
  @ApiZodBody(updateProductSchema)
  @ApiZodResponse(productSchema)
  update(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('productId', uuid('Product')) productId: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
  ): Promise<ProductResponse> {
    return this.products.update(m, locationId, productId, body);
  }

  @Delete('products/:productId')
  @RequireRoles('owner', 'manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a product; its past sales stay in the reports' })
  remove(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('productId', uuid('Product')) productId: string,
  ): Promise<void> {
    return this.products.remove(m, locationId, productId);
  }

  @Get('appointments/:appointmentId/products')
  @ApiOperation({ summary: 'Products sold at the visit (whoever sees the visit)' })
  @ApiZodResponse(visitProductSalesSchema)
  sales(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
  ): Promise<VisitProductSalesResponse> {
    return this.products.sales(m, auth.userId, locationId, appointmentId);
  }

  @Post('appointments/:appointmentId/products')
  @ApiOperation({
    summary: 'Note a product sold at the visit',
    description:
      'Who may change the visit. Only at a visit that took place (409 NOT_COMPLETED). The price is the product’s at this moment; not part of the visit price, loyalty points or discounts.',
  })
  @ApiZodBody(addProductSaleSchema)
  @ApiZodResponse(visitProductSalesSchema, HttpStatus.CREATED)
  addSale(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Body(new ZodValidationPipe(addProductSaleSchema)) body: AddProductSaleInput,
  ): Promise<VisitProductSalesResponse> {
    return this.products.addSale(m, auth.userId, locationId, appointmentId, body);
  }

  @Delete('appointments/:appointmentId/products/:saleId')
  @ApiOperation({ summary: 'Remove a product noted by mistake' })
  @ApiZodResponse(visitProductSalesSchema)
  removeSale(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Param('saleId', uuid('Product sale')) saleId: string,
  ): Promise<VisitProductSalesResponse> {
    return this.products.removeSale(m, auth.userId, locationId, appointmentId, saleId);
  }
}
