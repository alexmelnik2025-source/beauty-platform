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
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentAuth } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import type { AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CSV_LOCALES } from '../reports/visits-csv';
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
  restockProductSchema,
  stockHistorySchema,
  stockCsvQuerySchema,
  updateProductSchema,
  visitProductSalesSchema,
  type AddProductSaleInput,
  type CreateProductInput,
  type ProductListResponse,
  type ProductResponse,
  type RestockProductInput,
  type StockHistoryResponse,
  type StockCsvQuery,
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

  @Get('products/export.csv')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: '"CSV stanu magazynowego": the products with what is in stock, for ordering',
    description:
      'Task 436. Owners and managers. One line per product — name, price, sold or not, in stock, runs low at, to order (yes for a sold product that has run low or out). Same file format as visits-csv; an empty cell where the pieces are not counted.',
  })
  @ApiQuery({ name: 'locale', required: false, enum: CSV_LOCALES })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'The CSV file', schema: { type: 'string' } })
  async stockCsv(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Query(new ZodValidationPipe(stockCsvQuerySchema)) query: StockCsvQuery,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, fileName } = await this.products.stockCsv(m, locationId, query.locale);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(csv);
  }

  @Post('products')
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'Add a product to the list' })
  @ApiZodBody(createProductSchema)
  @ApiZodResponse(productSchema, HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
  ): Promise<ProductResponse> {
    return this.products.create(m, auth.userId, locationId, body);
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
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('productId', uuid('Product')) productId: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
  ): Promise<ProductResponse> {
    return this.products.update(m, auth.userId, locationId, productId, body);
  }

  @Post('products/:productId/restock')
  @RequireRoles('owner', 'manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '"Dostawa": add the pieces that arrived to what is in stock',
    description:
      'Task 438. In one step, so a sale at the same moment is not lost. A product that did not count its pieces starts counting with these. More than 100000 in stock → 409 STOCK_LIMIT.',
  })
  @ApiZodBody(restockProductSchema)
  @ApiZodResponse(productSchema)
  restock(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('productId', uuid('Product')) productId: string,
    @Body(new ZodValidationPipe(restockProductSchema)) body: RestockProductInput,
  ): Promise<ProductResponse> {
    return this.products.restock(m, auth.userId, locationId, productId, body);
  }

  @Get('products/:productId/stock-history')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: '"Historia magazynu": the last changes of the pieces in stock',
    description:
      'Task 440. Owners and managers. Sales, removed sales, deliveries and numbers written by hand — with who and when, newest first (at most 100).',
  })
  @ApiZodResponse(stockHistorySchema)
  stockHistory(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('productId', uuid('Product')) productId: string,
  ): Promise<StockHistoryResponse> {
    return this.products.stockHistory(m, locationId, productId);
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
      'Who may change the visit. Only at a visit that took place (409 NOT_COMPLETED). The price is the product’s at this moment; not part of the visit price, loyalty points or discounts. Task 429: a product that counts its stock loses the pieces sold; more than there are → 409 OUT_OF_STOCK. Removing the sale puts them back.',
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
