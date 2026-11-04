import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiZodResponse } from '../common/openapi';
import type { MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../organizations/membership.guard';
import {
  auditLogQuerySchema,
  auditLogSchema,
  AuditLogService,
  type AuditLogQuery,
  type AuditLogResponse,
} from './audit-log.service';

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations/:orgId/audit-log')
@UseGuards(MembershipGuard)
export class AuditLogController {
  constructor(private readonly log: AuditLogService) {}

  @Get()
  @RequireRoles('owner')
  @ApiOperation({
    summary: 'Who changed what in the salon, newest first (owner only)',
    description: 'Field names only, never their values. Visits have their own history.',
  })
  @ApiQuery({ name: 'before', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiZodResponse(auditLogSchema)
  list(
    @CurrentMembership() m: MembershipContext,
    @Query(new ZodValidationPipe(auditLogQuerySchema)) query: AuditLogQuery,
  ): Promise<AuditLogResponse> {
    return this.log.list(m, query);
  }
}
