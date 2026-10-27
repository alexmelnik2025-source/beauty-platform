import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { setClientCookie } from '../client/client-session';
import { notFound } from '../common/app-exception';
import { Idempotent } from '../common/idempotency.interceptor';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { APP_CONFIG, type AppConfig } from '../config/config';
import {
  clientCancelSchema,
  clientRescheduleSchema,
  confirmSchema,
  createHoldSchema,
  releaseHoldSchema,
  sendCodeSchema,
  type ClientRescheduleInput,
  type ConfirmInput,
  type CreateHoldInput,
  type SendCodeInput,
} from './booking.schemas';
import {
  bookingConfirmedSchema,
  codeSentSchema,
  holdSchema,
  publicAppointmentSchema,
  type BookingConfirmedResponse,
  type CodeSentResponse,
  type HoldResponse,
  type PublicAppointmentResponse,
} from './public-booking.responses';
import { PublicBookingService } from './public-booking.service';

const holdIdPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Hold') });
const MINUTE = 60_000;

@ApiTags('public booking')
@Public()
@Controller('public')
export class PublicBookingController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly booking: PublicBookingService,
    private readonly limiter: RateLimiterService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.secureCookies = config.NODE_ENV === 'production';
  }

  @Post('locations/:slug/holds')
  @Idempotent()
  @ApiOperation({
    summary: '1. Hold a slot for 10 minutes',
    description:
      'start = a slot "start" from the availability list. Omit staffId for "any staff member". Send releaseHoldToken to free a previous hold.',
  })
  @ApiZodBody(createHoldSchema)
  @ApiZodResponse(holdSchema, HttpStatus.CREATED)
  createHold(
    @Req() req: AppRequest,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(createHoldSchema)) body: CreateHoldInput,
  ): Promise<HoldResponse> {
    return this.booking.createHold(slug, body, req.ip ?? 'unknown');
  }

  @Post('holds/:holdId/code')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: '2. Send contact details; a 6-digit code goes by email or SMS',
    description:
      'Call again to resend (at most 3 codes per hold). The code never outlives the hold. ' +
      'codeChannel=sms sends it to the phone when the salon page lists sms in codeChannels; ' +
      'an SMS code confirms the phone, not the email (no "My visits" sign-in on confirm).',
  })
  @ApiZodBody(sendCodeSchema)
  @ApiZodResponse(codeSentSchema, HttpStatus.ACCEPTED)
  sendCode(
    @Req() req: AppRequest,
    @Param('holdId', holdIdPipe) holdId: string,
    @Body(new ZodValidationPipe(sendCodeSchema)) body: SendCodeInput,
  ): Promise<CodeSentResponse> {
    this.limiter.hit(`code:ip:${req.ip}`, 20, 60 * MINUTE);
    return this.booking.sendCode(holdId, body, req.ip ?? null);
  }

  @Post('holds/:holdId/confirm')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: '3. Confirm with the code — the appointment is booked',
    description:
      'Returns manageToken for the "manage my appointment" link (also sent by email). ' +
      'signIn=true (web): also signs the client in to "My visits" on this device — the session ' +
      'cookie is set and signedIn is true.',
  })
  @ApiZodBody(confirmSchema)
  @ApiZodResponse(bookingConfirmedSchema)
  async confirm(
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('holdId', holdIdPipe) holdId: string,
    @Body(new ZodValidationPipe(confirmSchema)) body: ConfirmInput,
  ): Promise<BookingConfirmedResponse> {
    this.limiter.hit(`confirm:ip:${req.ip}`, 30, 10 * MINUTE);
    const { appointment, manageToken, clientSession } = await this.booking.confirm(
      holdId,
      body,
      req.header('user-agent') ?? null,
    );
    // The session token never goes into the body (nor into the stored idempotent response).
    if (clientSession) {
      setClientCookie(res, clientSession.token, clientSession.expiresAt, this.secureCookies);
    }
    return { appointment, manageToken, signedIn: clientSession !== null };
  }

  @Post('holds/:holdId/release')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Give the held slot back (client closed the form)' })
  @ApiZodBody(releaseHoldSchema)
  release(
    @Param('holdId', holdIdPipe) holdId: string,
    @Body(new ZodValidationPipe(releaseHoldSchema)) body: { holdToken: string },
  ): Promise<void> {
    return this.booking.releaseHold(holdId, body.holdToken);
  }

  @Get('appointments/:token')
  @ApiOperation({ summary: 'The appointment behind a "manage" link' })
  @ApiZodResponse(publicAppointmentSchema)
  get(@Req() req: AppRequest, @Param('token') token: string): Promise<PublicAppointmentResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * MINUTE);
    return this.booking.getByToken(token);
  }

  @Post('appointments/:token/cancel')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({ summary: 'Client cancels (until the salon’s deadline, default 2 h before)' })
  @ApiZodBody(clientCancelSchema)
  @ApiZodResponse(publicAppointmentSchema)
  cancel(
    @Req() req: AppRequest,
    @Param('token') token: string,
    @Body(new ZodValidationPipe(clientCancelSchema)) body: { reason?: string },
  ): Promise<PublicAppointmentResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * MINUTE);
    return this.booking.cancelByToken(token, body.reason);
  }

  @Post('appointments/:token/reschedule')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({ summary: 'Client moves the appointment to another free time' })
  @ApiZodBody(clientRescheduleSchema)
  @ApiZodResponse(publicAppointmentSchema)
  reschedule(
    @Req() req: AppRequest,
    @Param('token') token: string,
    @Body(new ZodValidationPipe(clientRescheduleSchema)) body: ClientRescheduleInput,
  ): Promise<PublicAppointmentResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * MINUTE);
    return this.booking.rescheduleByToken(token, body);
  }
}
