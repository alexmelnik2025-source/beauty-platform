import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ReservationsService } from './reservations.service';
import {
  reserveProductSchema,
  usedProductsSchema,
  visitProductsSchema,
  type UsedProductsResponse,
  type ReserveProductInput,
  type VisitProductsResponse,
  publicSalonProductsSchema,
  publicShopListSchema,
  publicShopProductSchema,
  publicShopQuerySchema,
  SHOP_CATEGORIES,
  type PublicSalonProductsResponse,
  type PublicShopListResponse,
  type PublicShopProductResponse,
  type PublicShopQuery,
} from './shop.schemas';
import { ShopService } from './shop.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

/**
 * Task Q3: what clients see — "Produkty salonu" on a salon's booking page and the "Sklep" tab of
 * the client app. Only public data: names, prices, whether a product is available, the salon's
 * name and address. Stock numbers, purchase prices and suppliers never leave the salon.
 */
@ApiTags('public')
@Public()
@Controller('public')
export class PublicShopController {
  constructor(
    private readonly shop: ShopService,
    private readonly reservations: ReservationsService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Get('locations/:slug/products')
  @ApiOperation({
    summary: '"Produkty salonu": what the salon sells to its clients, to pick up at a visit',
    description:
      'Task Q3. Only salons open for online booking (otherwise 404), only products the salon shows to clients (`inSalonShop`) and still sells. `available` is false when the salon counts its pieces and has none left.',
  })
  @ApiZodResponse(publicSalonProductsSchema)
  salonProducts(
    @Req() req: AppRequest,
    @Param('slug') slug: string,
  ): Promise<PublicSalonProductsResponse> {
    this.limiter.hit(`public:ip:${req.ip}`, 300, 60_000);
    return this.shop.salonProducts(slug);
  }

  @Get('shop/products')
  @ApiOperation({
    summary:
      'The "Sklep" tab: every product some salon sells online, with all the salons offering it',
    description:
      'Task Q3. A card is listed while at least one salon open for online booking sells it in the "Sklep" tab and has it (counts no pieces, or has some left). Offers: available first, cheapest first. At the launch every offer is picked up and paid at the salon.',
  })
  @ApiQuery({ name: 'q', required: false, type: String, example: 'pomada' })
  @ApiQuery({ name: 'category', required: false, enum: SHOP_CATEGORIES })
  @ApiQuery({
    name: 'city',
    required: false,
    type: String,
    example: 'Warszawa',
    description: 'Only the offers of salons in this city',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, minimum: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    type: Number,
    example: 24,
    minimum: 1,
    maximum: 50,
  })
  @ApiZodResponse(publicShopListSchema)
  list(
    @Req() req: AppRequest,
    @Query(new ZodValidationPipe(publicShopQuerySchema)) query: PublicShopQuery,
  ): Promise<PublicShopListResponse> {
    this.limiter.hit(`public:shop:ip:${req.ip}`, 120, 60_000);
    return this.shop.list(query);
  }

  @Get('shop/products/:cardId')
  @ApiOperation({
    summary: 'One product of the "Sklep" tab with every salon offering it',
    description:
      'Task Q3. 404 unless some salon open for online booking sells it in the "Sklep" tab.',
  })
  @ApiZodResponse(publicShopProductSchema)
  product(
    @Req() req: AppRequest,
    @Param('cardId', uuid('Product')) cardId: string,
  ): Promise<PublicShopProductResponse> {
    this.limiter.hit(`public:shop:ip:${req.ip}`, 120, 60_000);
    return this.shop.product(cardId);
  }

  // ── Task Q3 (part 4): products put aside for a visit, by the "manage" link ──

  @Get('appointments/:token/products')
  @ApiOperation({
    summary: 'Products the client put aside for this visit, and what else they may add',
    description:
      'Task Q3 (part 4). By the "manage" link of the visit. `canChange` while the visit is confirmed and ahead; `available` lists "Produkty salonu" (empty once the visit cannot be changed).',
  })
  @ApiZodResponse(visitProductsSchema)
  visitProducts(
    @Req() req: AppRequest,
    @Param('token') token: string,
  ): Promise<VisitProductsResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * 60_000);
    return this.reservations.byToken(token);
  }

  @Post('appointments/:token/products')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '"Odbiorę przy wizycie": put a product of the salon aside for this visit',
    description:
      'Task Q3 (part 4). Paid at the salon, no online payment. Only a product the salon shows to clients; more than the salon has left (after other clients’ reservations) → 409 OUT_OF_STOCK; a visit that started or is not confirmed → 409 TOO_LATE_TO_CHANGE.',
  })
  @ApiZodBody(reserveProductSchema)
  @ApiZodResponse(visitProductsSchema)
  reserve(
    @Req() req: AppRequest,
    @Param('token') token: string,
    @Body(new ZodValidationPipe(reserveProductSchema)) body: ReserveProductInput,
  ): Promise<VisitProductsResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * 60_000);
    return this.reservations.reserveByToken(token, body);
  }

  @Get('appointments/:token/products/used')
  @ApiOperation({
    summary: '"Jak było?": products the specialist used at this visit, to put aside for the next',
    description:
      'Task Q3 (screen C). Products sold at this visit that the salon still shows to clients, at today’s price; `nextVisit` is the client’s next confirmed visit in this salon (null = none — the page offers "Umów kolejną wizytę" with `rebook`).',
  })
  @ApiZodResponse(usedProductsSchema)
  usedProducts(
    @Req() req: AppRequest,
    @Param('token') token: string,
  ): Promise<UsedProductsResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * 60_000);
    return this.reservations.usedByToken(token);
  }

  @Post('appointments/:token/products/next')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '"Odłóż na następną wizytę": put a product used at this visit aside for the next one',
    description:
      'Task Q3 (screen C). Only a product sold at this visit (else 404); no next confirmed visit in this salon → 409 NO_NEXT_VISIT; not enough left → 409 OUT_OF_STOCK. Already waiting on the next visit → nothing changes. Paid at the salon.',
  })
  @ApiZodBody(reserveProductSchema)
  @ApiZodResponse(usedProductsSchema)
  reserveForNext(
    @Req() req: AppRequest,
    @Param('token') token: string,
    @Body(new ZodValidationPipe(reserveProductSchema)) body: ReserveProductInput,
  ): Promise<UsedProductsResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * 60_000);
    return this.reservations.reserveForNextByToken(token, body);
  }

  @Delete('appointments/:token/products/:reservationId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The client takes a product back (until the visit starts)',
    description: 'Task Q3 (part 4). Only a product still waiting; otherwise 404.',
  })
  @ApiZodResponse(visitProductsSchema)
  unreserve(
    @Req() req: AppRequest,
    @Param('token') token: string,
    @Param('reservationId', uuid('Reservation')) reservationId: string,
  ): Promise<VisitProductsResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * 60_000);
    return this.reservations.cancelByToken(token, reservationId);
  }
}
