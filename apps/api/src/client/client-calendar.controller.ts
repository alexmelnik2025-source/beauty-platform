import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Public } from '../auth/decorators';
import { VisitCalendarService } from '../booking/visit-calendar.service';
import { notFound } from '../common/app-exception';
import { ApiZodResponse, responseSchema } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import { ClientGuard, CurrentClient } from './client-auth';
import type { ClientAuth } from './client.service';

const idPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Appointment') });
const MINUTE = 60_000;

export const calendarLinkSchema = responseSchema(
  'CalendarLink',
  z.strictObject({
    url: z
      .string()
      .describe('The visit as an .ics file; opening it adds the visit to the calendar'),
  }),
);

/** Task 22: "Add to calendar" in the client app. */
@ApiTags('client app')
@Public()
@Controller('client')
export class ClientCalendarController {
  constructor(
    private readonly calendar: VisitCalendarService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Post('appointments/:id/calendar-link')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'A link to one of my visits as a calendar file (.ics), to open on the phone',
  })
  @ApiZodResponse(calendarLinkSchema)
  link(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
  ): Promise<{ url: string }> {
    // Task 617: every link is a manage token of the visit; one client does not mint them
    // without end.
    this.limiter.hit(`calendar-link:client:${client.personId}`, 30, 10 * MINUTE);
    return this.calendar.linkForClient(client.email, id);
  }
}
