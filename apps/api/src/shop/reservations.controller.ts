import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentAuth } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodResponse } from '../common/openapi';
import type { AuthContext, MembershipContext } from '../common/request-context';
import { CurrentMembership, MembershipGuard } from '../organizations/membership.guard';
import { ReservationsService } from './reservations.service';
import { visitReservationsSchema, type VisitReservationsResponse } from './shop.schemas';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

/**
 * Task Q3 (part 4, the salon's side — screen D): "Do wydania klientowi" in the visit card. Who
 * sees the visit sees what waits for the client; who may change the visit hands a product over
 * (the usual sale at the visit) or takes it back.
 */
@ApiTags('shop')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/appointments/:appointmentId/reservations')
@UseGuards(MembershipGuard)
export class VisitReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Products the client put aside for this visit ("Do wydania klientowi")',
  })
  @ApiZodResponse(visitReservationsSchema)
  list(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
  ): Promise<VisitReservationsResponse> {
    return this.reservations.forVisit(m, auth.userId, locationId, appointmentId);
  }

  @Post(':reservationId/hand-over')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '"Rozlicz wizytę i produkt": the product is handed over and sold at this visit',
    description:
      'Task Q3 (part 4). The usual sale of task 394: the visit must be marked "came" (409 NOT_COMPLETED), the pieces leave the stock (409 OUT_OF_STOCK), the price is the product’s now. A product no longer waiting → 409 NOT_RESERVED.',
  })
  @ApiZodResponse(visitReservationsSchema)
  handOver(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Param('reservationId', uuid('Reservation')) reservationId: string,
  ): Promise<VisitReservationsResponse> {
    return this.reservations.handOver(m, auth.userId, locationId, appointmentId, reservationId);
  }

  @Post(':reservationId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The salon takes a waiting product back',
    description: 'Task Q3 (part 4). Whoever may change the visit. Not waiting → 409 NOT_RESERVED.',
  })
  @ApiZodResponse(visitReservationsSchema)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Param('reservationId', uuid('Reservation')) reservationId: string,
  ): Promise<VisitReservationsResponse> {
    return this.reservations.cancelBySalon(
      m,
      auth.userId,
      locationId,
      appointmentId,
      reservationId,
    );
  }
}
