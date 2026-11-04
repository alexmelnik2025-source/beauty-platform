import { visitWishesInputSchema, type VisitWishesInput } from '../booking/visit-wishes';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import {
  clientCancelSchema,
  clientRescheduleSchema,
  type ClientRescheduleInput,
} from '../booking/booking.schemas';
import { notFound } from '../common/app-exception';
import { Idempotent } from '../common/idempotency.interceptor';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { clearClientCookie, ClientGuard, CurrentClient, setClientCookie } from './client-auth';
import { visitCouponsSchema, type VisitCouponsResponse } from '../booking/booking.responses';
import {
  clientApplyCouponSchema,
  listClientAppointmentsSchema,
  requestClientCodeSchema,
  updatePersonSchema,
  verifyClientCodeSchema,
  type ClientApplyCouponInput,
  type ListClientAppointmentsInput,
  type RequestClientCodeInput,
  type UpdatePersonInput,
  type VerifyClientCodeInput,
} from './client.schemas';
import {
  clientAppointmentListSchema,
  clientAppointmentSchema,
  clientCodeSentSchema,
  clientPersonSchema,
  clientSignInSchema,
  type ClientAppointmentResponse,
  type ClientSignInResponse,
  type PersonResponse,
} from './client.responses';
import { ClientService, type ClientAuth } from './client.service';
import { clientLoyaltySchema, type ClientLoyaltyResponse } from './client-loyalty.responses';
import { ClientLoyaltyService } from './client-loyalty.service';

const MINUTE = 60_000;
const idPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Appointment') });

/** "My visits" — the client app. Separate sign-in from salon accounts. */
@ApiTags('client app')
@Public()
@Controller('client')
export class ClientController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly clients: ClientService,
    private readonly loyalty: ClientLoyaltyService,
    private readonly limiter: RateLimiterService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.secureCookies = config.NODE_ENV === 'production';
  }

  @Post('auth/code')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Email a 6-digit sign-in code',
    description:
      'Always 202, whether or not the address has visits. A new code replaces the previous one.',
  })
  @ApiZodBody(requestClientCodeSchema)
  @ApiZodResponse(clientCodeSentSchema, HttpStatus.ACCEPTED)
  requestCode(
    @Req() req: AppRequest,
    @Body(new ZodValidationPipe(requestClientCodeSchema)) body: RequestClientCodeInput,
  ): Promise<{ codeExpiresAt: string }> {
    this.limiter.hit(`client-code:ip:${req.ip}`, 20, 60 * MINUTE);
    return this.clients.requestCode(body);
  }

  @Post('auth/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with the code',
    description:
      'clientType=web: the session is an httpOnly cookie (90 days). clientType=mobile: the token is returned in the body.',
  })
  @ApiZodBody(verifyClientCodeSchema)
  @ApiZodResponse(clientSignInSchema)
  async verify(
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(verifyClientCodeSchema)) body: VerifyClientCodeInput,
  ): Promise<ClientSignInResponse> {
    this.limiter.hit(`client-verify:ip:${req.ip}`, 30, 10 * MINUTE);
    const issued = await this.clients.verifyCode(body, req.header('user-agent') ?? null);
    const response: ClientSignInResponse = {
      person: issued.person,
      expiresAt: issued.expiresAt.toISOString(),
    };
    if (body.clientType === 'mobile') return { ...response, token: issued.token };
    setClientCookie(res, issued.token, issued.expiresAt, this.secureCookies);
    return response;
  }

  @Post('auth/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ClientGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out of this device' })
  async logout(
    @CurrentClient() client: ClientAuth,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.clients.signOut(client);
    clearClientCookie(res, this.secureCookies);
  }

  @Get('me')
  @UseGuards(ClientGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The signed-in client' })
  @ApiZodResponse(clientPersonSchema)
  me(@CurrentClient() client: ClientAuth): Promise<PersonResponse> {
    return this.clients.me(client);
  }

  @Patch('me')
  @UseGuards(ClientGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change the language of the client app and emails' })
  @ApiZodBody(updatePersonSchema)
  @ApiZodResponse(clientPersonSchema)
  updateMe(
    @CurrentClient() client: ClientAuth,
    @Body(new ZodValidationPipe(updatePersonSchema)) body: UpdatePersonInput,
  ): Promise<PersonResponse> {
    return this.clients.updateMe(client, body.locale);
  }

  @Get('loyalty')
  @UseGuards(ClientGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'My bonuses in all salons',
    description:
      'Stamps or points, rewards and how much is missing, coupons and history in every salon where the client has a card with the confirmed email and the program is on (or a coupon is still usable).',
  })
  @ApiZodResponse(clientLoyaltySchema)
  loyaltyCards(@CurrentClient() client: ClientAuth): Promise<ClientLoyaltyResponse> {
    return this.loyalty.list(client);
  }

  @Get('appointments')
  @UseGuards(ClientGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'My visits in all salons',
    description:
      'Found by the confirmed email of the client. scope=upcoming (soonest first) or past (latest 50).',
  })
  @ApiZodResponse(clientAppointmentListSchema)
  list(
    @CurrentClient() client: ClientAuth,
    @Query(new ZodValidationPipe(listClientAppointmentsSchema)) query: ListClientAppointmentsInput,
  ): Promise<{ items: ClientAppointmentResponse[] }> {
    return this.clients.list(client, query);
  }

  @Get('appointments/:id')
  @UseGuards(ClientGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One of my visits' })
  @ApiZodResponse(clientAppointmentSchema)
  get(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
  ): Promise<ClientAppointmentResponse> {
    return this.clients.get(client, id);
  }

  @Post('appointments/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @UseGuards(ClientGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel (until the salon’s deadline, default 2 h before)' })
  @ApiZodBody(clientCancelSchema)
  @ApiZodResponse(clientAppointmentSchema)
  cancel(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(clientCancelSchema)) body: { reason?: string },
  ): Promise<ClientAppointmentResponse> {
    return this.clients.cancel(client, id, body.reason);
  }

  @Post('appointments/:id/reschedule')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @UseGuards(ClientGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Move to another free time',
    description: 'start = a slot from GET /v1/public/locations/{slug}/availability.',
  })
  @ApiZodBody(clientRescheduleSchema)
  @ApiZodResponse(clientAppointmentSchema)
  reschedule(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(clientRescheduleSchema)) body: ClientRescheduleInput,
  ): Promise<ClientAppointmentResponse> {
    return this.clients.reschedule(client, id, body);
  }

  @Put('appointments/:id/wishes')
  @UseGuards(ClientGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change the visit wishes (task 80), until the visit starts',
    description: '409 TOO_LATE_TO_CHANGE once the visit has started.',
  })
  @ApiZodBody(visitWishesInputSchema)
  @ApiZodResponse(clientAppointmentSchema)
  updateWishes(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(visitWishesInputSchema)) body: VisitWishesInput,
  ): Promise<ClientAppointmentResponse> {
    return this.clients.updateWishes(client, id, body);
  }

  @Get('appointments/:id/coupons')
  @UseGuards(ClientGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'My coupons in this salon: used on the visit, and the others with what each takes off',
  })
  @ApiZodResponse(visitCouponsSchema)
  coupons(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
  ): Promise<VisitCouponsResponse> {
    return this.clients.coupons(client, id);
  }

  @Post('appointments/:id/coupons')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Use one of my coupons on an upcoming visit (until the salon’s deadline)',
    description:
      "409 TOO_LATE_TO_CHANGE after the deadline; the salon's rules as for the salon (COUPON_NOT_FOR_SERVICE, COUPON_NOT_COMBINABLE, COUPON_NO_DISCOUNT, COUPON_EXPIRED, COUPON_NOT_ACTIVE).",
  })
  @ApiZodBody(clientApplyCouponSchema)
  @ApiZodResponse(clientAppointmentSchema)
  applyCoupon(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(clientApplyCouponSchema)) body: ClientApplyCouponInput,
  ): Promise<ClientAppointmentResponse> {
    return this.clients.applyCoupon(client, id, body);
  }

  @Post('appointments/:id/coupons/:couponId/remove')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Take a coupon off an upcoming visit (until the salon’s deadline)' })
  @ApiZodResponse(clientAppointmentSchema)
  removeCoupon(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
    @Param('couponId', new ParseUUIDPipe({ exceptionFactory: () => notFound('Coupon') }))
    couponId: string,
  ): Promise<ClientAppointmentResponse> {
    return this.clients.removeCoupon(client, id, couponId);
  }
}
