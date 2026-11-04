import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentAuth } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import type { AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../organizations/membership.guard';
import {
  replaceStaffPricesSchema,
  staffPricesSchema,
  StaffPricesService,
  type ReplaceStaffPricesInput,
  type StaffPricesResponse,
} from './staff-prices';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

/** Task 62: each specialist's own price of a service. */
@ApiTags('services')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId')
@UseGuards(MembershipGuard)
export class StaffPricesController {
  constructor(private readonly prices: StaffPricesService) {}

  @Get('staff-prices')
  @ApiOperation({ summary: "Specialists' own prices of services at this location" })
  @ApiZodResponse(staffPricesSchema)
  list(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<StaffPricesResponse> {
    return this.prices.list(m, locationId);
  }

  @Put('services/:serviceId/staff-prices')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: "Set the specialists' own prices of a service (the others take its price)",
    description:
      'Only specialists who perform the service; priceGrosze null = the service price. Booked visits keep their price.',
  })
  @ApiZodBody(replaceStaffPricesSchema)
  @ApiZodResponse(staffPricesSchema)
  replace(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('serviceId', uuid('Service')) serviceId: string,
    @Body(new ZodValidationPipe(replaceStaffPricesSchema)) body: ReplaceStaffPricesInput,
  ): Promise<StaffPricesResponse> {
    return this.prices.replace(m, auth.userId, locationId, serviceId, body);
  }
}
