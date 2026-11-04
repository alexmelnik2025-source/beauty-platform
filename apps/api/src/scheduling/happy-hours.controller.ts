import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { notFound } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import type { MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../organizations/membership.guard';
import { HappyHoursService } from './happy-hours';
import { happyHoursSchema, type HappyHoursResponse } from './happy-hours.responses';
import { replaceHappyHoursSchema, type ReplaceHappyHoursInput } from './happy-hours.schemas';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

/** The salon's happy hours (task 16): a lower price on chosen weekdays and hours. */
@ApiTags('services')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/happy-hours')
@UseGuards(MembershipGuard)
export class HappyHoursController {
  constructor(private readonly happyHours: HappyHoursService) {}

  @Get()
  @ApiOperation({ summary: "The location's happy hours" })
  @ApiZodResponse(happyHoursSchema)
  list(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<HappyHoursResponse> {
    return this.happyHours.list(m, locationId);
  }

  @Put()
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Replace the happy hours (empty list = none)',
    description:
      "Every new visit (online, by the staff, walk-ins) starting in a rule's weekdays and hours, with its staff member and service, gets the largest matching discount on the price. Visits already booked keep their price. Staff and services must be this location's (400 VALIDATION_ERROR).",
  })
  @ApiZodBody(replaceHappyHoursSchema)
  @ApiZodResponse(happyHoursSchema)
  replace(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(replaceHappyHoursSchema)) body: ReplaceHappyHoursInput,
  ): Promise<HappyHoursResponse> {
    return this.happyHours.replace(m, locationId, body);
  }
}
