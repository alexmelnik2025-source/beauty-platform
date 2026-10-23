import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { Idempotent } from '../common/idempotency.interceptor';
import { ApiZodBody } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
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
  PublicBookingService,
  type HoldResponse,
  type PublicAppointmentResponse,
} from './public-booking.service';

const holdIdPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Hold') });
const MINUTE = 60_000;

@ApiTags('public booking')
@Public()
@Controller('public')
export class PublicBookingController {
  constructor(
    private readonly booking: PublicBookingService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Post('locations/:slug/holds')
  @Idempotent()
  @ApiOperation({
    summary: '1. Hold a slot for 10 minutes',
    description:
      'start = a slot "start" from the availability list. Omit staffId for "any staff member". Send releaseHoldToken to free a previous hold.',
  })
  @ApiZodBody(createHoldSchema)
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
    summary: '2. Send contact details; a 6-digit code is emailed',
    description: 'Call again to resend (at most 3 codes per hold). The code never outlives the hold.',
  })
  @ApiZodBody(sendCodeSchema)
  sendCode(
    @Req() req: AppRequest,
    @Param('holdId', holdIdPipe) holdId: string,
    @Body(new ZodValidationPipe(sendCodeSchema)) body: SendCodeInput,
  ): Promise<{ codeExpiresAt: string }> {
    this.limiter.hit(`code:ip:${req.ip}`, 20, 60 * MINUTE);
    return this.booking.sendCode(holdId, body, req.ip ?? null);
  }

  @Post('holds/:holdId/confirm')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: '3. Confirm with the code — the appointment is booked',
    description: 'Returns manageToken for the "manage my appointment" link (also sent by email).',
  })
  @ApiZodBody(confirmSchema)
  confirm(
    @Req() req: AppRequest,
    @Param('holdId', holdIdPipe) holdId: string,
    @Body(new ZodValidationPipe(confirmSchema)) body: ConfirmInput,
  ): Promise<{ appointment: PublicAppointmentResponse; manageToken: string }> {
    this.limiter.hit(`confirm:ip:${req.ip}`, 30, 10 * MINUTE);
    return this.booking.confirm(holdId, body);
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
  get(@Req() req: AppRequest, @Param('token') token: string): Promise<PublicAppointmentResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * MINUTE);
    return this.booking.getByToken(token);
  }

  @Post('appointments/:token/cancel')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({ summary: 'Client cancels (until the salon’s deadline, default 2 h before)' })
  @ApiZodBody(clientCancelSchema)
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
  reschedule(
    @Req() req: AppRequest,
    @Param('token') token: string,
    @Body(new ZodValidationPipe(clientRescheduleSchema)) body: ClientRescheduleInput,
  ): Promise<PublicAppointmentResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * MINUTE);
    return this.booking.rescheduleByToken(token, body);
  }
}
