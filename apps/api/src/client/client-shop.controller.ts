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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ReservationsService } from '../shop/reservations.service';
import {
  reserveProductSchema,
  usedProductsSchema,
  visitProductsSchema,
  type ReserveProductInput,
  type UsedProductsResponse,
  type VisitProductsResponse,
} from '../shop/shop.schemas';
import { ClientGuard, CurrentClient } from './client-auth';
import { ClientService, type ClientAuth } from './client.service';

const idPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Appointment') });
const reservationPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Reservation') });
const productPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Product') });

/**
 * Task Q3 (screen B in the client app): "Produkty do odbioru" in "Moje wizyty" — the same as on
 * the visit link (`/public/appointments/{token}/products`), for the signed-in client's own visit.
 * Someone else's visit looks like a missing one.
 */
@ApiTags('client app')
@Public()
@Controller('client/appointments/:id/products')
@UseGuards(ClientGuard)
@ApiBearerAuth()
export class ClientShopController {
  constructor(
    private readonly clients: ClientService,
    private readonly reservations: ReservationsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Products I put aside for my visit, and what else I may add',
    description:
      'Task Q3. `canChange` while the visit is confirmed and ahead; `available` = the salon’s products for clients.',
  })
  @ApiZodResponse(visitProductsSchema)
  async list(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
  ): Promise<VisitProductsResponse> {
    const visit = await this.clients.myVisit(client, id);
    return this.reservations.forClient(visit, visit.location);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '"Odbiorę przy wizycie": put a product aside for my visit (paid at the salon)',
    description:
      'Task Q3. More than the salon has left → 409 OUT_OF_STOCK; a visit that started or is not confirmed → 409 TOO_LATE_TO_CHANGE.',
  })
  @ApiZodBody(reserveProductSchema)
  @ApiZodResponse(visitProductsSchema)
  async reserve(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(reserveProductSchema)) body: ReserveProductInput,
  ): Promise<VisitProductsResponse> {
    const visit = await this.clients.myVisit(client, id);
    await this.reservations.reserve(visit, visit.location, body);
    return this.reservations.forClient(visit, visit.location);
  }

  @Get('used')
  @ApiOperation({
    summary: '"Jak było?": products used at my visit, to put aside for my next one',
    description:
      'Task Q3 (screen C). The same as on the visit link (`/public/appointments/{token}/products/used`).',
  })
  @ApiZodResponse(usedProductsSchema)
  async used(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
  ): Promise<UsedProductsResponse> {
    const visit = await this.clients.myVisit(client, id);
    return this.reservations.used(visit, visit.location);
  }

  @Post('next')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '"Odłóż na następną wizytę": put a product used at my visit aside for my next one',
    description:
      'Task Q3 (screen C). Only a product sold at this visit (else 404); not enough left → 409 OUT_OF_STOCK. No next confirmed visit in this salon yet → the choice is kept and moves to the next visit when it is booked (audit EJ fix).',
  })
  @ApiZodBody(reserveProductSchema)
  @ApiZodResponse(usedProductsSchema)
  async reserveForNext(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(reserveProductSchema)) body: ReserveProductInput,
  ): Promise<UsedProductsResponse> {
    const visit = await this.clients.myVisit(client, id);
    await this.reservations.reserveForNext(visit, visit.location, body);
    return this.reservations.used(visit, visit.location);
  }

  @Delete('next/:productId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Undo "Odłóż na następną wizytę" chosen while there was no next visit yet',
    description: 'Audit EJ fix. Only a choice still waiting for the next visit; otherwise 404.',
  })
  @ApiZodResponse(usedProductsSchema)
  async forgetNext(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
    @Param('productId', productPipe) productId: string,
  ): Promise<UsedProductsResponse> {
    const visit = await this.clients.myVisit(client, id);
    await this.reservations.forgetNext(visit, productId);
    return this.reservations.used(visit, visit.location);
  }

  @Delete(':reservationId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take a product back (until the visit starts)',
    description: 'Task Q3. Only a product still waiting; otherwise 404.',
  })
  @ApiZodResponse(visitProductsSchema)
  async unreserve(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
    @Param('reservationId', reservationPipe) reservationId: string,
  ): Promise<VisitProductsResponse> {
    const visit = await this.clients.myVisit(client, id);
    await this.reservations.cancelByClient(visit, reservationId);
    return this.reservations.forClient(visit, visit.location);
  }
}
