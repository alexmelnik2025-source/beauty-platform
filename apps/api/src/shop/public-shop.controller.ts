import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodResponse } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
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
}
