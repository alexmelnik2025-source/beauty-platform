import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
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
  loyaltyAccountSchema,
  loyaltyProgramSchema,
  loyaltyTransactionListSchema,
  type LoyaltyAccountResponse,
  type LoyaltyProgramResponse,
  type LoyaltyTransactionResponse,
} from './loyalty.responses';
import {
  listLoyaltyTransactionsSchema,
  replaceEarnRulesSchema,
  updateLoyaltyProgramSchema,
  type ListLoyaltyTransactionsQuery,
  type ReplaceEarnRulesInput,
  type UpdateLoyaltyProgramInput,
} from './loyalty.schemas';
import { LoyaltyService } from './loyalty.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

/**
 * The salon's loyalty program (docs/LOYALTY.md). Owners and managers only: staff
 * members can never create stamps or points — those come only from paid visits.
 */
@ApiTags('loyalty')
@ApiBearerAuth()
@Controller('organizations/:orgId')
@UseGuards(MembershipGuard)
@RequireRoles('owner', 'manager')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get('loyalty/program')
  @ApiOperation({ summary: 'Loyalty program settings (defaults with version 0 if never saved)' })
  @ApiZodResponse(loyaltyProgramSchema)
  getProgram(@CurrentMembership() m: MembershipContext): Promise<LoyaltyProgramResponse> {
    return this.loyalty.getProgram(m);
  }

  @Put('loyalty/program')
  @ApiOperation({
    summary: 'Save the loyalty program settings. Send the version you read',
    description:
      '409 LOYALTY_MODE_LOCKED: the type (stamps/points) cannot change while clients have a balance.',
  })
  @ApiZodBody(updateLoyaltyProgramSchema)
  @ApiZodResponse(loyaltyProgramSchema)
  updateProgram(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Body(new ZodValidationPipe(updateLoyaltyProgramSchema)) body: UpdateLoyaltyProgramInput,
  ): Promise<LoyaltyProgramResponse> {
    return this.loyalty.updateProgram(m, auth.userId, body);
  }

  @Put('locations/:locationId/loyalty/earn-rules')
  @ApiOperation({
    summary: 'Stamps or points per service of one location (replaces that location’s list)',
  })
  @ApiZodBody(replaceEarnRulesSchema)
  @ApiZodResponse(loyaltyProgramSchema)
  replaceEarnRules(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(replaceEarnRulesSchema)) body: ReplaceEarnRulesInput,
  ): Promise<LoyaltyProgramResponse> {
    return this.loyalty.replaceEarnRules(m, auth.userId, locationId, body);
  }

  @Get('loyalty/accounts/:customerId')
  @ApiOperation({ summary: 'A client’s balance and history in the program' })
  @ApiZodResponse(loyaltyAccountSchema)
  getAccount(
    @CurrentMembership() m: MembershipContext,
    @Param('customerId', uuid('Customer')) customerId: string,
  ): Promise<LoyaltyAccountResponse> {
    return this.loyalty.getAccount(m, customerId);
  }

  @Get('loyalty/transactions')
  @ApiOperation({ summary: 'Every loyalty operation of the salon, newest first' })
  @ApiQuery({ name: 'customerId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiZodResponse(loyaltyTransactionListSchema)
  listTransactions(
    @CurrentMembership() m: MembershipContext,
    @Query(new ZodValidationPipe(listLoyaltyTransactionsSchema))
    query: ListLoyaltyTransactionsQuery,
  ): Promise<LoyaltyTransactionResponse[]> {
    return this.loyalty.listTransactions(m, query);
  }
}
