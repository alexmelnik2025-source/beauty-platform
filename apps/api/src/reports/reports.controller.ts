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
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentAuth } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import type { AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentMembership, MembershipGuard } from '../organizations/membership.guard';
import { CommissionsService } from './commissions.service';
import {
  salonReportSchema,
  staffCommissionsSchema,
  tillCloseSchema,
  type SalonReport,
  type StaffCommissionsResponse,
  type TillCloseResponse,
} from './reports.responses';
import {
  closeTillSchema,
  reportQuerySchema,
  staffCommissionSchema,
  tillCloseQuerySchema,
  tillMovementSchema,
  visitsCsvQuerySchema,
  type CloseTillInput,
  type ReportQuery,
  type StaffCommissionInput,
  type TillCloseQuery,
  type TillMovementInput,
  type VisitsCsvQuery,
} from './reports.schemas';
import { CSV_LOCALES } from './visits-csv';
import { ReportsService } from './reports.service';
import { TillCloseService } from './till-close.service';

const locationIdPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Location') });
const staffIdPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Staff member') });
const movementIdPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Till movement') });

@ApiTags('reports')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/reports')
@UseGuards(MembershipGuard)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly till: TillCloseService,
    private readonly commissions: CommissionsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Salon report for a period: visits, revenue, clients, by specialist, service and day',
    description:
      'Owners and managers: the whole salon. A specialist: only their own visits, and only with the "viewOwnEarnings" permission (403 otherwise). At most 366 days.',
  })
  @ApiQuery({ name: 'from', example: '2026-11-01' })
  @ApiQuery({ name: 'to', example: '2026-11-30' })
  @ApiZodResponse(salonReportSchema)
  get(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', locationIdPipe) locationId: string,
    @Query(new ZodValidationPipe(reportQuerySchema)) query: ReportQuery,
  ): Promise<SalonReport> {
    return this.reports.get(m, auth.userId, locationId, query);
  }

  @Get('visits-csv')
  @ApiOperation({
    summary: 'Every visit of a period as a CSV file for the accountant',
    description:
      'Same access as the report. UTF-8 with a byte order mark, ";" between columns, decimal comma (point for en); no client contacts.',
  })
  @ApiQuery({ name: 'from', example: '2026-11-01' })
  @ApiQuery({ name: 'to', example: '2026-11-30' })
  @ApiQuery({ name: 'locale', required: false, enum: CSV_LOCALES })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'The CSV file', schema: { type: 'string' } })
  async visitsCsv(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', locationIdPipe) locationId: string,
    @Query(new ZodValidationPipe(visitsCsvQuerySchema)) query: VisitsCsvQuery,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, fileName } = await this.reports.visitsCsv(
      m,
      auth.userId,
      locationId,
      query,
      query.locale,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(csv);
  }

  @Get('till-csv')
  @ApiOperation({
    summary: 'The till of a period as a CSV cash journal for the accountant',
    description:
      'Task 238. Owners and managers of the location only (a specialist gets 403). One line for every cash put in or taken out and every till close, oldest first. Same file format as visits-csv.',
  })
  @ApiQuery({ name: 'from', example: '2026-11-01' })
  @ApiQuery({ name: 'to', example: '2026-11-30' })
  @ApiQuery({ name: 'locale', required: false, enum: CSV_LOCALES })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'The CSV file', schema: { type: 'string' } })
  async tillCsv(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', locationIdPipe) locationId: string,
    @Query(new ZodValidationPipe(visitsCsvQuerySchema)) query: VisitsCsvQuery,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, fileName } = await this.till.csv(m, locationId, query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(csv);
  }

  @Get('till-close')
  @ApiOperation({
    summary: "The day's till: what the visits paid in cash brought and the cash counted",
    description:
      'Task 232. Owners and managers of the location only (a specialist gets 403). close is null until the till of that day is counted.',
  })
  @ApiQuery({ name: 'date', example: '2026-11-07' })
  @ApiZodResponse(tillCloseSchema)
  tillClose(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', locationIdPipe) locationId: string,
    @Query(new ZodValidationPipe(tillCloseQuerySchema)) query: TillCloseQuery,
  ): Promise<TillCloseResponse> {
    return this.till.get(m, locationId, query.date);
  }

  @Put('till-close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '"Zamknij kasę": note the cash counted in the till at the end of a day',
    description:
      'Task 232. Owners and managers only. Counting the same day again replaces the note. 409 DAY_NOT_STARTED for a day after today (salon time). Only a note — no payment systems.',
  })
  @ApiZodBody(closeTillSchema)
  @ApiZodResponse(tillCloseSchema)
  closeTill(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', locationIdPipe) locationId: string,
    @Body(new ZodValidationPipe(closeTillSchema)) body: CloseTillInput,
  ): Promise<TillCloseResponse> {
    return this.till.close(m, auth.userId, locationId, body);
  }

  @Post('till-movements')
  @ApiOperation({
    summary: '"Wpłata / wypłata": note cash put into or taken out of the till on a day',
    description:
      'Task 236. Owners and managers only. kind "in" — put in (e.g. change for the day), "out" — taken out (e.g. towels, to the bank); note says why. The till should then hold the cash visits plus "in" minus "out". 409 DAY_NOT_STARTED for a day after today (salon time). Answers the till of that day.',
  })
  @ApiZodBody(tillMovementSchema)
  @ApiZodResponse(tillCloseSchema, HttpStatus.CREATED)
  addTillMovement(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', locationIdPipe) locationId: string,
    @Body(new ZodValidationPipe(tillMovementSchema)) body: TillMovementInput,
  ): Promise<TillCloseResponse> {
    return this.till.addMovement(m, auth.userId, locationId, body);
  }

  @Delete('till-movements/:movementId')
  @ApiOperation({
    summary: 'Remove a cash movement noted by mistake',
    description: 'Task 236. Owners and managers only. Answers the till of its day.',
  })
  @ApiZodResponse(tillCloseSchema)
  removeTillMovement(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', locationIdPipe) locationId: string,
    @Param('movementId', movementIdPipe) movementId: string,
  ): Promise<TillCloseResponse> {
    return this.till.removeMovement(m, locationId, movementId);
  }

  @Get('commissions')
  @ApiOperation({
    summary: '"Prowizje": the commission of every specialist of the location',
    description:
      "Task 373. Owners and managers of the location only (a specialist gets 403): a commission is a team member's pay. The report then shows each specialist's revenue × commission.",
  })
  @ApiZodResponse(staffCommissionsSchema)
  listCommissions(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', locationIdPipe) locationId: string,
  ): Promise<StaffCommissionsResponse> {
    return this.commissions.list(m, locationId);
  }

  @Put('commissions/:staffId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Set or remove (null) a specialist's commission in percent",
    description:
      'Task 373. Owners and managers only. 0–100, at most one decimal place. Answers the whole list.',
  })
  @ApiZodBody(staffCommissionSchema)
  @ApiZodResponse(staffCommissionsSchema)
  setCommission(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', locationIdPipe) locationId: string,
    @Param('staffId', staffIdPipe) staffId: string,
    @Body(new ZodValidationPipe(staffCommissionSchema)) body: StaffCommissionInput,
  ): Promise<StaffCommissionsResponse> {
    return this.commissions.set(m, auth.userId, locationId, staffId, body);
  }
}
