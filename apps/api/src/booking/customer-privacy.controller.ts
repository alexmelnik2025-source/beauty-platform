import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentAuth } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { Idempotent } from '../common/idempotency.interceptor';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import type { AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../organizations/membership.guard';
import {
  anonymizeCustomerSchema,
  anonymizedCustomerSchema,
  customerExportSchema,
  CustomerPrivacyService,
  type AnonymizeCustomerInput,
  type AnonymizedCustomerResponse,
  type CustomerExportResponse,
} from './customer-privacy.service';

const customerIdPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Customer') });

/** Task 21: the client's GDPR requests — export and erasure, by the salon owner only. */
@ApiTags('customers')
@ApiBearerAuth()
@Controller('organizations/:orgId/customers/:customerId')
@UseGuards(MembershipGuard)
@RequireRoles('owner')
export class CustomerPrivacyController {
  constructor(private readonly privacy: CustomerPrivacyService) {}

  @Get('export')
  @ApiOperation({
    summary: 'Everything kept about the client, as a JSON file (GDPR access request; owner only)',
  })
  @ApiZodResponse(customerExportSchema)
  async export(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('customerId', customerIdPipe) customerId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerExportResponse> {
    const body = await this.privacy.export(m, auth.userId, customerId);
    res.setHeader('Content-Disposition', `attachment; filename="client-${customerId}.json"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return body;
  }

  @Post('anonymize')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: "Erase the client's personal data (GDPR; owner only)",
    description:
      'Name becomes "—"; phone, email, notes, tags, visit notes, cancellation reasons and manage links are removed. Visits, prices and loyalty entries stay for statistics. 409 CUSTOMER_HAS_UPCOMING_VISITS while visits are planned; 409 CUSTOMER_ANONYMIZED when already erased.',
  })
  @ApiZodBody(anonymizeCustomerSchema)
  @ApiZodResponse(anonymizedCustomerSchema)
  anonymize(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('customerId', customerIdPipe) customerId: string,
    @Body(new ZodValidationPipe(anonymizeCustomerSchema)) body: AnonymizeCustomerInput,
  ): Promise<AnonymizedCustomerResponse> {
    return this.privacy.anonymize(m, auth.userId, customerId, body);
  }
}
