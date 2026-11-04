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
import {
  joinWaitlistSchema,
  waitlistEntrySchema,
  waitlistSchema,
  WaitlistService,
  type JoinWaitlistInput,
  type WaitlistEntryResponse,
} from '../booking/waitlist.service';
import { notFound } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ClientGuard, CurrentClient } from './client-auth';
import type { ClientAuth } from './client.service';

const idPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Waitlist entry') });

/** Waiting list (task 24): "email me when a time frees up on this day". */
@ApiTags('client app')
@Public()
@UseGuards(ClientGuard)
@ApiBearerAuth()
@Controller('client/waitlist')
export class ClientWaitlistController {
  constructor(
    private readonly waitlist: WaitlistService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My waiting lists: days still to come, soonest first' })
  @ApiZodResponse(waitlistSchema)
  list(@CurrentClient() client: ClientAuth): Promise<{ items: WaitlistEntryResponse[] }> {
    return this.waitlist.list(client);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Join the waiting list for a day',
    description:
      'One email to the confirmed address when a visit that day is cancelled or moved and a time is free for this service (and specialist, if chosen). Joining the same day again re-arms it. 400 DATE_OUT_OF_RANGE outside today…booking horizon; 409 TOO_MANY_WAITLIST over 10 days.',
  })
  @ApiZodBody(joinWaitlistSchema)
  @ApiZodResponse(waitlistEntrySchema, HttpStatus.CREATED)
  join(
    @CurrentClient() client: ClientAuth,
    @Body(new ZodValidationPipe(joinWaitlistSchema)) body: JoinWaitlistInput,
  ): Promise<WaitlistEntryResponse> {
    this.limiter.hit(`client-waitlist:person:${client.personId}`, 30, 60 * 60_000);
    return this.waitlist.join(client, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Leave a waiting list' })
  leave(@CurrentClient() client: ClientAuth, @Param('id', idPipe) id: string): Promise<void> {
    return this.waitlist.leave(client, id);
  }
}
