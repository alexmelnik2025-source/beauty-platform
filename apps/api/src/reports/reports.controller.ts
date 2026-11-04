import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { notFound } from '../common/app-exception';
import { ApiZodResponse } from '../common/openapi';
import type { MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../organizations/membership.guard';
import { salonReportSchema, type SalonReportResponse } from './reports.responses';
import { reportQuerySchema, type ReportQuery } from './reports.schemas';
import { ReportsService } from './reports.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

/** Reports for the salon's owner and managers (task 14). Staff members never see them. */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/reports')
@UseGuards(MembershipGuard)
@RequireRoles('owner', 'manager')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'What happened at the location between two local days (max 366 days)',
    description:
      'Visits, no-shows, cancellations and what the clients paid (after discounts), by staff member, service and day. Owners and managers of the location only.',
  })
  @ApiQuery({ name: 'from', example: '2026-11-01' })
  @ApiQuery({ name: 'to', example: '2026-11-30' })
  @ApiZodResponse(salonReportSchema)
  summary(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Query(new ZodValidationPipe(reportQuerySchema)) query: ReportQuery,
  ): Promise<SalonReportResponse> {
    return this.reports.summary(m, locationId, query);
  }
}
