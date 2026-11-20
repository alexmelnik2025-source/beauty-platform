import {
  applyDecorators,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentAuth } from '../../auth/decorators';
import { notFound } from '../../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi';
import type { AppRequest, AuthContext, MembershipContext } from '../../common/request-context';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../../organizations/membership.guard';
import {
  feedImportResultSchema,
  feedPreviewSchema,
  importFeedSchema,
  type FeedImportResultResponse,
  type FeedPreviewResponse,
  type ImportFeedInput,
} from './feed.schemas';
import { ShopFeedService } from './feed.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

const FeedBody = () =>
  applyDecorators(
    ApiConsumes('text/csv', 'application/xml', 'text/xml', 'text/plain'),
    ApiBody({
      description:
        'The file itself (not a form), at most 10 MB and 5000 products: Google Merchant XML, Ceneo XML or CSV (; , or tab; UTF-8 or Windows-1250)',
      schema: { type: 'string', format: 'binary' },
    }),
  );

/**
 * Task Q4 (part 3): "Integracje" → "Importuj z pliku" — for sellers without Base. Owners and
 * managers only.
 */
@ApiTags('shop')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/shop/integrations/feed')
@UseGuards(MembershipGuard)
@RequireRoles('owner', 'manager')
export class ShopFeedController {
  constructor(private readonly feeds: ShopFeedService) {}

  @Post()
  @ApiOperation({
    summary: 'Send a product file and see what was read from it',
    description:
      'Columns of a CSV are found by their names (nazwa/name, ean/gtin, sku/symbol, cena/price, stan/ilość/stock, marka/producent, opis, zdjęcie/image, id). 413 FEED_TOO_LARGE, 415 UNSUPPORTED_FEED, 422 FEED_EMPTY. The file is kept for a day.',
  })
  @FeedBody()
  @ApiZodResponse(feedPreviewSchema, HttpStatus.CREATED)
  upload(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Req() req: AppRequest,
  ): Promise<FeedPreviewResponse> {
    return this.feeds.upload(m, auth.userId, locationId, req);
  }

  @Post(':feedId/import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Import the ticked rows of a sent file (up to 500 at once)',
    description:
      'Like the Base import: each becomes the salon’s product ("Produkty salonu"); `online: true` also shows it in "Sklep"; joined to the card with the same EAN or a new card is made; importing again renews price, stock and code. A file older than a day → 404.',
  })
  @ApiZodBody(importFeedSchema)
  @ApiZodResponse(feedImportResultSchema)
  import(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('feedId', uuid('Feed')) feedId: string,
    @Body(new ZodValidationPipe(importFeedSchema)) body: ImportFeedInput,
  ): Promise<FeedImportResultResponse> {
    return this.feeds.import(m, auth.userId, locationId, feedId, body);
  }
}
