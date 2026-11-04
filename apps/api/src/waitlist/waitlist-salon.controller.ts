import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentAuth } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodResponse } from '../common/openapi';
import type { AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../organizations/membership.guard';
import {
  salonWaitlistEntrySchema,
  salonWaitlistSchema,
  type SalonWaitlistEntryResponse,
  type SalonWaitlistResponse,
} from './waitlist.responses';
import { salonWaitlistQuerySchema, type SalonWaitlistQuery } from './waitlist.schemas';
import { WaitlistService } from './waitlist.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

/** Task 50c: the salon's waiting list in the cabinet — owners and managers only. */
@ApiTags('booking')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/waitlist')
@UseGuards(MembershipGuard)
@RequireRoles('owner', 'manager')
export class WaitlistSalonController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Get()
  @ApiOperation({
    summary: 'Who waits for a free time at this location (from a day on, by day)',
    description:
      'Waiting and already told clients from `from` (default: today in the salon time zone) on, ' +
      'with names and contacts. Clients who left the list or were removed are not listed.',
  })
  @ApiQuery({ name: 'from', required: false, description: 'YYYY-MM-DD' })
  @ApiZodResponse(salonWaitlistSchema)
  list(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Query(new ZodValidationPipe(salonWaitlistQuerySchema)) query: SalonWaitlistQuery,
  ): Promise<SalonWaitlistResponse> {
    return this.waitlist.listForSalon(m, locationId, query);
  }

  @Post(':entryId/remove')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a client from the waiting list ("Usuń z listy")',
    description: 'No email is sent; removing twice is fine. The entry is kept as cancelled.',
  })
  @ApiZodResponse(salonWaitlistEntrySchema)
  remove(
    @CurrentMembership() m: MembershipContext,
    @CurrentAuth() auth: AuthContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('entryId', uuid('Waiting list entry')) entryId: string,
  ): Promise<SalonWaitlistEntryResponse> {
    return this.waitlist.removeBySalon(m, auth.userId, locationId, entryId);
  }
}
