import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  publicWaitlistEntrySchema,
  waitlistJoinedSchema,
  type PublicWaitlistEntryResponse,
  type WaitlistJoinedResponse,
} from './waitlist.responses';
import { joinWaitlistSchema, type JoinWaitlistInput } from './waitlist.schemas';
import { WaitlistService } from './waitlist.service';

const MINUTE = 60_000;

/** Task 50: the waiting list on the booking page and the client's link from the email. */
@ApiTags('public booking')
@Public()
@Controller('public')
export class WaitlistController {
  constructor(
    private readonly waitlist: WaitlistService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Post('locations/:slug/waitlist')
  @ApiOperation({
    summary: 'Tell me when a time becomes free (a full day)',
    description:
      'One email when a time becomes free on that day. 409 SLOTS_AVAILABLE: the day has free times, ' +
      'book one; 409 WAITLIST_LIMIT: this email already waits for 3 days at the salon; ' +
      '400 WAITLIST_DATE: outside today … the booking horizon.',
  })
  @ApiZodBody(joinWaitlistSchema)
  @ApiZodResponse(waitlistJoinedSchema, HttpStatus.CREATED)
  join(
    @Req() req: AppRequest,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(joinWaitlistSchema)) body: JoinWaitlistInput,
  ): Promise<WaitlistJoinedResponse> {
    return this.waitlist.join(slug, body, req.ip ?? 'unknown');
  }

  @Get('waitlist/:token')
  @ApiOperation({ summary: 'The waiting-list entry behind the link in the email' })
  @ApiZodResponse(publicWaitlistEntrySchema)
  get(@Req() req: AppRequest, @Param('token') token: string): Promise<PublicWaitlistEntryResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * MINUTE);
    return this.waitlist.get(token);
  }

  @Post('waitlist/:token/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Leave the waiting list' })
  @ApiZodResponse(publicWaitlistEntrySchema)
  cancel(
    @Req() req: AppRequest,
    @Param('token') token: string,
  ): Promise<PublicWaitlistEntryResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * MINUTE);
    return this.waitlist.cancel(token);
  }
}
