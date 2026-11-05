import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
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
  cancellationGuardSchema,
  guardedClientSchema,
  guardedClientsSchema,
  type CancellationGuardResponse,
  type GuardedClientResponse,
  type GuardedClientsResponse,
} from './cancellation-guard.responses';
import {
  releaseCustomerSchema,
  updateCancellationGuardSchema,
  type ReleaseCustomerInput,
  type UpdateCancellationGuardInput,
} from './cancellation-guard.schemas';
import { CancellationGuardService } from './cancellation-guard.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

/** Task 161: "Ochrona przed odwołaniami" — owners and managers of the location only. */
@ApiTags('clients')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/cancellation-guard')
@UseGuards(MembershipGuard)
@RequireRoles('owner', 'manager')
export class CancellationGuardController {
  constructor(private readonly guard: CancellationGuardService) {}

  @Get()
  @ApiOperation({
    summary: 'The cancellation guard settings of the location (off until the salon saves them)',
  })
  @ApiZodResponse(cancellationGuardSchema)
  get(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<CancellationGuardResponse> {
    return this.guard.get(m, locationId);
  }

  @Put()
  @ApiOperation({
    summary: 'Save the cancellation guard settings',
    description:
      'A client is marked when, since the salon last lifted the mark: N cancellations or reschedules by the client fall within the last X hours, any cancellation comes less than Y minutes before the visit, or M visits were missed (the last 365 days count). A rule set to null is off; turning the guard on needs at least one rule. version: 0 before the first save; 409 VERSION_CONFLICT when someone saved first.',
  })
  @ApiZodBody(updateCancellationGuardSchema)
  @ApiZodResponse(cancellationGuardSchema)
  update(
    @CurrentMembership() m: MembershipContext,
    @CurrentAuth() auth: AuthContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(updateCancellationGuardSchema)) body: UpdateCancellationGuardInput,
  ): Promise<CancellationGuardResponse> {
    return this.guard.update(m, auth.userId, locationId, body);
  }

  @Get('clients')
  @ApiOperation({
    summary: 'Clients the guard marks now',
    description: 'Empty while the guard is off. Anonymised clients are left out.',
  })
  @ApiZodResponse(guardedClientsSchema)
  clients(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<GuardedClientsResponse> {
    return this.guard.clients(m, locationId);
  }

  @Get('clients/:customerId')
  @ApiOperation({
    summary: "One client's mark and the history of cancellations, reschedules and no-shows",
  })
  @ApiZodResponse(guardedClientSchema)
  client(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('customerId', uuid('Customer')) customerId: string,
  ): Promise<GuardedClientResponse> {
    return this.guard.client(m, locationId, customerId);
  }

  @Post('clients/:customerId/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lift the mark (e.g. the client paid the missed visits in the salon)',
    description: 'Counting starts again from now. The history keeps everything.',
  })
  @ApiZodBody(releaseCustomerSchema)
  @ApiZodResponse(guardedClientSchema)
  release(
    @CurrentMembership() m: MembershipContext,
    @CurrentAuth() auth: AuthContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('customerId', uuid('Customer')) customerId: string,
    @Body(new ZodValidationPipe(releaseCustomerSchema)) body: ReleaseCustomerInput,
  ): Promise<GuardedClientResponse> {
    return this.guard.release(m, auth.userId, locationId, customerId, body);
  }
}
