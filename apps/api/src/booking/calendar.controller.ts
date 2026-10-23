import {
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentAuth } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import type { AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentMembership, MembershipGuard } from '../organizations/membership.guard';
import { listAppointmentsSchema, type ListAppointmentsQuery } from './booking.schemas';
import { CalendarService, type CalendarResponse } from './calendar.service';

const locationIdPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Location') });

@ApiTags('calendar')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/calendar')
@UseGuards(MembershipGuard)
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get()
  @ApiOperation({
    summary: 'Calendar: staff hours, time off, appointments and blocks for a date range',
    description:
      'Refresh every 30 s with If-None-Match: <ETag of the last response>; 304 means nothing visible has changed.',
  })
  @ApiQuery({ name: 'from', example: '2026-11-02' })
  @ApiQuery({ name: 'to', example: '2026-11-02' })
  @ApiQuery({ name: 'staffId', required: false })
  @ApiHeader({ name: 'If-None-Match', required: false })
  async get(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', locationIdPipe) locationId: string,
    @Query(new ZodValidationPipe(listAppointmentsSchema)) query: ListAppointmentsQuery,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CalendarResponse | undefined> {
    const { body, etag } = await this.calendar.get(m, auth.userId, locationId, query);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    if (ifNoneMatch === etag) {
      res.status(304);
      return undefined;
    }
    return body;
  }
}
