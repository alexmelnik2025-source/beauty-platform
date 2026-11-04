import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentAuth } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodResponse } from '../common/openapi';
import type { AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentMembership, MembershipGuard } from '../organizations/membership.guard';
import { salonReportSchema, type SalonReport } from './reports.responses';
import { reportQuerySchema, type ReportQuery } from './reports.schemas';
import { ReportsService } from './reports.service';

const locationIdPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Location') });

@ApiTags('reports')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/reports')
@UseGuards(MembershipGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

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
}
