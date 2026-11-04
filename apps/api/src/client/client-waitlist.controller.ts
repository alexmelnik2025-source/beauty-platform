import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import type { AppRequest } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  clientWaitlistEntrySchema,
  clientWaitlistSchema,
  waitlistJoinedSchema,
  type ClientWaitlistEntryResponse,
  type ClientWaitlistResponse,
  type WaitlistJoinedResponse,
} from '../waitlist/waitlist.responses';
import {
  clientJoinWaitlistSchema,
  type ClientJoinWaitlistInput,
} from '../waitlist/waitlist.schemas';
import { WaitlistService } from '../waitlist/waitlist.service';
import { ClientGuard, CurrentClient } from './client-auth';
import type { ClientAuth } from './client.service';

const idPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Waiting list entry') });

/** Task 51: the waiting list (task 50) in the client app — with the signed-in client's email. */
@ApiTags('client app')
@Public()
@UseGuards(ClientGuard)
@ApiBearerAuth()
@Controller('client/waitlist')
export class ClientWaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Get()
  @ApiOperation({
    summary: 'My waiting lists in every salon',
    description: 'Days from today on (salon time zone), soonest first; left/removed are not shown.',
  })
  @ApiZodResponse(clientWaitlistSchema)
  list(@CurrentClient() client: ClientAuth): Promise<ClientWaitlistResponse> {
    return this.waitlist.listForClient(client.email);
  }

  @Post('locations/:slug')
  @ApiOperation({
    summary: 'Tell me when a time becomes free (a full day), with my email',
    description:
      'Same rules as the booking page: 409 SLOTS_AVAILABLE, 409 WAITLIST_LIMIT, 400 WAITLIST_DATE.',
  })
  @ApiZodBody(clientJoinWaitlistSchema)
  @ApiZodResponse(waitlistJoinedSchema, HttpStatus.CREATED)
  join(
    @Req() req: AppRequest,
    @CurrentClient() client: ClientAuth,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(clientJoinWaitlistSchema)) body: ClientJoinWaitlistInput,
  ): Promise<WaitlistJoinedResponse> {
    return this.waitlist.joinAsClient(client.email, slug, body, req.ip ?? 'unknown');
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Leave one of my waiting lists (404 for anyone else’s)' })
  @ApiZodResponse(clientWaitlistEntrySchema)
  cancel(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
  ): Promise<ClientWaitlistEntryResponse> {
    return this.waitlist.cancelForClient(client.email, id);
  }
}
