import { Controller, Get, HttpStatus, Param, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest } from '../common/request-context';
import { VisitCalendarService } from './visit-calendar.service';

const MINUTE = 60_000;

@ApiTags('public booking')
@Public()
@Controller('public')
export class VisitCalendarController {
  constructor(
    private readonly calendar: VisitCalendarService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Get('appointments/:token/calendar.ics')
  @ApiOperation({
    summary: 'The appointment behind a "manage" link as a calendar file (.ics)',
    description:
      'For "Add to calendar". UID stays the same and SEQUENCE grows with each change, so importing it again updates the event; a cancelled visit has STATUS:CANCELLED.',
  })
  @ApiProduces('text/calendar')
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'iCalendar (RFC 5545)',
    content: { 'text/calendar': { schema: { type: 'string' } } },
  })
  async get(
    @Req() req: AppRequest,
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * MINUTE);
    const file = await this.calendar.byToken(token);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return file.body;
  }
}
