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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentAuth } from '../../auth/decorators';
import { notFound } from '../../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi';
import type { AuthContext, MembershipContext } from '../../common/request-context';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../../organizations/membership.guard';
import {
  baseImportResultSchema,
  baseIntegrationSchema,
  baseOptionsSchema,
  baseProductsQuerySchema,
  baseProductsSchema,
  baseSyncRunSchema,
  baseSyncRunsSchema,
  configureBaseSchema,
  connectBaseSchema,
  importBaseSchema,
  type BaseImportResultResponse,
  type BaseIntegrationResponse,
  type BaseOptionsResponse,
  type BaseProductsQuery,
  type BaseProductsResponse,
  type BaseSyncRunResponse,
  type BaseSyncRunsResponse,
  type ConfigureBaseInput,
  type ConnectBaseInput,
  type ImportBaseInput,
} from './integrations.schemas';
import { ShopIntegrationsService } from './integrations.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

/**
 * Task Q4 (part 1): "Mój sklep" → "Integracje" → "Base (BaseLinker)" — connect the seller's own
 * Base in three steps (token → catalogue, price group, warehouse → tick products) and import.
 * Owners and managers only. Errors of Base: 422 BASE_TOKEN_INVALID, 502 BASE_ERROR /
 * BASE_UNREACHABLE.
 */
@ApiTags('shop')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/shop/integrations/base')
@UseGuards(MembershipGuard)
@RequireRoles('owner', 'manager')
export class ShopIntegrationsController {
  constructor(private readonly integrations: ShopIntegrationsService) {}

  @Get()
  @ApiOperation({ summary: 'Is Base connected, and what was chosen (never the token)' })
  @ApiZodResponse(baseIntegrationSchema)
  status(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<BaseIntegrationResponse> {
    return this.integrations.status(m, locationId);
  }

  @Put()
  @ApiOperation({
    summary: 'Step 1: connect with the API token from Base (Moje konto → API)',
    description:
      'Base must accept the token first (422 BASE_TOKEN_INVALID otherwise). The token is stored encrypted and never sent back; pasting a new one replaces it and keeps the choices.',
  })
  @ApiZodBody(connectBaseSchema)
  @ApiZodResponse(baseIntegrationSchema)
  connect(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(connectBaseSchema)) body: ConnectBaseInput,
  ): Promise<BaseIntegrationResponse> {
    return this.integrations.connect(m, auth.userId, locationId, body);
  }

  @Delete()
  @ApiOperation({
    summary: '"Odłącz Base": forget the token',
    description: 'Imported products stay as the salon’s own; connecting again joins them back.',
  })
  @ApiZodResponse(baseIntegrationSchema)
  disconnect(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<BaseIntegrationResponse> {
    return this.integrations.disconnect(m, locationId);
  }

  @Get('options')
  @ApiOperation({
    summary: 'Step 2: catalogues, price groups and warehouses of the seller’s Base',
    description:
      '409 BASE_NOT_CONNECTED without a token; 409 BASE_RECONNECT when it must be pasted again.',
  })
  @ApiZodResponse(baseOptionsSchema)
  options(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<BaseOptionsResponse> {
    return this.integrations.options(m, locationId);
  }

  @Patch()
  @ApiOperation({
    summary: 'Step 2: choose the catalogue, price group and warehouse',
    description:
      'The price group must be in the salon’s currency and both it and the warehouse in the chosen catalogue (422 BASE_INVALID_CHOICE).',
  })
  @ApiZodBody(configureBaseSchema)
  @ApiZodResponse(baseIntegrationSchema)
  configure(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(configureBaseSchema)) body: ConfigureBaseInput,
  ): Promise<BaseIntegrationResponse> {
    return this.integrations.configure(m, locationId, body);
  }

  @Get('products')
  @ApiOperation({
    summary: 'Step 3: a page of the seller’s catalogue to tick products from',
    description:
      'Up to 1000 products a page, as Base gives them, with the price and stock of the chosen group and warehouse, and what the platform already has (imported product, card with the same EAN). 409 BASE_NOT_CONFIGURED before step 2.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, minimum: 1 })
  @ApiZodResponse(baseProductsSchema)
  products(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Query(new ZodValidationPipe(baseProductsQuerySchema)) query: BaseProductsQuery,
  ): Promise<BaseProductsResponse> {
    return this.integrations.products(m, locationId, query);
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Step 3: import the ticked products (up to 200 at once)',
    description:
      'Each becomes the salon’s product on its booking page ("Produkty salonu"); `online: true` also shows it in "Sklep". Joined to the platform card with the same EAN, or a new card is made. Importing again renews the price, stock and code. Nothing else is published.',
  })
  @ApiZodBody(importBaseSchema)
  @ApiZodResponse(baseImportResultSchema)
  import(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(importBaseSchema)) body: ImportBaseInput,
  ): Promise<BaseImportResultResponse> {
    return this.integrations.import(m, auth.userId, locationId, body);
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '"Synchronizuj teraz": renew prices and stock of the imported products',
    description:
      'Task Q4 (part 2). Otherwise it happens every `syncEveryMinutes`. Base errors do not fail the request: they are in `errorCode` of the run (and in the log). Again within a minute → 409 BASE_SYNC_TOO_SOON.',
  })
  @ApiZodResponse(baseSyncRunSchema)
  sync(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<BaseSyncRunResponse> {
    return this.integrations.syncNow(m, auth.userId, locationId);
  }

  @Get('runs')
  @ApiOperation({
    summary: '"Dziennik synchronizacji": the latest imports and renewals',
    description: 'Task Q4 (part 2). At most 20, newest first; empty when Base is not connected.',
  })
  @ApiZodResponse(baseSyncRunsSchema)
  runs(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<BaseSyncRunsResponse> {
    return this.integrations.runs(m, locationId);
  }
}
