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
  replaceStaffDurationsSchema,
  replaceStaffPricesSchema,
  staffPricesSchema,
  StaffPricesService,
  type ReplaceStaffDurationsInput,
  type ReplaceStaffPricesInput,
  type StaffPricesResponse,
} from './staff-prices';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

/** Tasks 62 and 70: each specialist's own price and duration of a service. */
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

  @Put('services/:serviceId/staff-durations')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: "Set the specialists' own durations of a service (the others take its duration)",
    description:
      'Task 70. Only specialists who perform the service; durationMinutes null = the service duration (5–480, a multiple of 5). Free times and new visits use the specialist duration; booked visits keep theirs.',
  })
  @ApiZodBody(replaceStaffDurationsSchema)
  @ApiZodResponse(staffPricesSchema)
  replaceDurations(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('serviceId', uuid('Service')) serviceId: string,
    @Body(new ZodValidationPipe(replaceStaffDurationsSchema)) body: ReplaceStaffDurationsInput,
  ): Promise<StaffPricesResponse> {
    return this.prices.replaceDurations(m, auth.userId, locationId, serviceId, body);
  }
}
