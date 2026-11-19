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
  deliveryResultSchema,
  deliverySchema,
  productListSchema,
  productSchema,
  restockProductSchema,
  stockHistorySchema,
  stocktakeResultSchema,
  stocktakeSchema,
  stockCsvQuerySchema,
  updateProductSchema,
  visitProductSalesSchema,
  writeOffProductSchema,
  type AddProductSaleInput,
  type CreateProductInput,
  type DeliveryInput,
  type DeliveryResponse,
  type ProductListResponse,
  type ProductResponse,
  type RestockProductInput,
  type StockHistoryResponse,
  type StocktakeInput,
  type StocktakeResponse,
  type StockCsvQuery,
  type UpdateProductInput,
  type VisitProductSalesResponse,
  type WriteOffProductInput,
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
      'Task 436. Owners and managers. One line per product — name, price, sold or not, in stock, runs low at, to order (yes for a sold product that has run low or out), purchase price, supplier (task 462), pieces sold at the visits of the last 30 days (task 469). Same file format as visits-csv; an empty cell where the pieces are not counted. With `supplier`, only that supplier’s products; with `toOrder=true`, only the products to order (task 469).',
  })
  @ApiQuery({ name: 'locale', required: false, enum: CSV_LOCALES })
  @ApiQuery({ name: 'supplier', required: false, type: String })
  @ApiQuery({ name: 'toOrder', required: false, enum: ['true', 'false'] })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'The CSV file', schema: { type: 'string' } })
  async stockCsv(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Query(new ZodValidationPipe(stockCsvQuerySchema)) query: StockCsvQuery,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, fileName } = await this.products.stockCsv(
      m,
      locationId,
      query.locale,
      query.supplier,
      query.toOrder ?? false,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(csv);
  }

  @Post('products')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Add a product to the list',
    description:
      'A barcode ("Kod kreskowy", task 520) another product of the salon already has → 409 BARCODE_TAKEN.',
  })
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
    description:
      'Past sales keep the name and price they had. A barcode ("Kod kreskowy", task 520) another product of the salon already has → 409 BARCODE_TAKEN.',
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

  @Post('products/stocktake')
  @RequireRoles('owner', 'manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '"Inwentaryzacja": write the pieces counted on the shelf, for many products at once',
    description:
      'Task 456. Owners and managers. Each counted number replaces what was in stock; a number that differs is written to "Historia magazynu" as stocktake. A product that did not count its pieces starts counting. A product of another salon or a missing one → 404, nothing is changed.',
  })
  @ApiZodBody(stocktakeSchema)
  @ApiZodResponse(stocktakeResultSchema)
  stocktake(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(stocktakeSchema)) body: StocktakeInput,
  ): Promise<StocktakeResponse> {
    return this.products.stocktake(m, auth.userId, locationId, body);
  }

  @Post('products/delivery')
  @RequireRoles('owner', 'manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '"Przyjmij dostawę": add the pieces that arrived, for many products at once',
    description:
      'Task 475. Owners and managers. Each number is added to what is in stock and written to "Historia magazynu" as a delivery, in one transaction. A product that did not count its pieces starts counting with these. More than 100000 in stock → 409 STOCK_LIMIT; a product of another salon or a missing one → 404; nothing is changed then.',
  })
  @ApiZodBody(deliverySchema)
  @ApiZodResponse(deliveryResultSchema)
  delivery(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(deliverySchema)) body: DeliveryInput,
  ): Promise<DeliveryResponse> {
    return this.products.delivery(m, auth.userId, locationId, body);
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

  @Post('products/:productId/write-off')
  @RequireRoles('owner', 'manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '"Odpis": take pieces used in the salon, damaged or lost from the stock',
    description:
      'Task 443. In one step, with an optional note shown in "Historia magazynu". More than in stock → 409 OUT_OF_STOCK; a product that does not count its pieces → 409 NOT_COUNTED.',
  })
  @ApiZodBody(writeOffProductSchema)
  @ApiZodResponse(productSchema)
  writeOff(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('productId', uuid('Product')) productId: string,
    @Body(new ZodValidationPipe(writeOffProductSchema)) body: WriteOffProductInput,
  ): Promise<ProductResponse> {
    return this.products.writeOff(m, auth.userId, locationId, productId, body);
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
