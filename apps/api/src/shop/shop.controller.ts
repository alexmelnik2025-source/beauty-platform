import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { notFound } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import type { MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../organizations/membership.guard';
import {
  catalogProductSchema,
  catalogSearchResultSchema,
  catalogSearchSchema,
  createCatalogProductSchema,
  updateCatalogProductSchema,
  type CatalogProductResponse,
  type CatalogSearchQuery,
  type CatalogSearchResponse,
  type CreateCatalogProductInput,
  type UpdateCatalogProductInput,
} from './shop.schemas';
import { ShopService } from './shop.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

/**
 * Task Q3: the platform catalogue as the salon sees it in "Mój sklep" — search a card to offer,
 * make a new one. The salon's offer itself is its product (POST/PATCH …/products with
 * `catalogProductId`, `inSalonShop`, `inMarketplace`).
 */
@ApiTags('shop')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/shop/catalog')
@UseGuards(MembershipGuard)
export class ShopCatalogController {
  constructor(private readonly shop: ShopService) {}

  @Get()
  @ApiOperation({
    summary: '"Wybierz z katalogu": cards of the platform catalogue by name, brand or EAN',
    description:
      'Task Q3. Everyone in the salon. `q` — words of the name or brand, or the code on the package (an exact EAN comes first). `offeredHere` says which product of this salon already points to the card.',
  })
  @ApiQuery({ name: 'q', required: false, type: String, example: 'pomada' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20, minimum: 1, maximum: 50 })
  @ApiZodResponse(catalogSearchResultSchema)
  search(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Query(new ZodValidationPipe(catalogSearchSchema)) query: CatalogSearchQuery,
  ): Promise<CatalogSearchResponse> {
    return this.shop.search(m, locationId, query);
  }

  @Post()
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'A new card in the platform catalogue',
    description:
      'Task Q3. Owners and managers. The name, brand, EAN, description and category are the same for every salon that offers the card. An EAN already in the catalogue → 409 EAN_TAKEN with the existing card’s id in `details[0].message` — offer that card instead.',
  })
  @ApiZodBody(createCatalogProductSchema)
  @ApiZodResponse(catalogProductSchema, HttpStatus.CREATED)
  create(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(createCatalogProductSchema)) body: CreateCatalogProductInput,
  ): Promise<CatalogProductResponse> {
    return this.shop.create(m, locationId, body);
  }

  @Get(':cardId')
  @ApiOperation({ summary: 'One card of the catalogue' })
  @ApiZodResponse(catalogProductSchema)
  get(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('cardId', uuid('CatalogProduct')) cardId: string,
  ): Promise<CatalogProductResponse> {
    return this.shop.get(m, locationId, cardId);
  }

  @Patch(':cardId')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Change a card this salon made',
    description:
      'Task Q3. Owners and managers; only the salon that made the card, and only while no other salon offers it (403 CARD_SHARED). A card made by another salon → 404.',
  })
  @ApiZodBody(updateCatalogProductSchema)
  @ApiZodResponse(catalogProductSchema)
  update(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('cardId', uuid('CatalogProduct')) cardId: string,
    @Body(new ZodValidationPipe(updateCatalogProductSchema)) body: UpdateCatalogProductInput,
  ): Promise<CatalogProductResponse> {
    return this.shop.update(m, locationId, cardId, body);
  }
}
