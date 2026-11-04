import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
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
  loyaltyCouponSchema,
  loyaltyProgramSchema,
  loyaltyTiersSchema,
  loyaltyRewardListSchema,
  loyaltyRewardSchema,
  loyaltyTransactionListSchema,
  type LoyaltyAccountResponse,
  type LoyaltyCouponResponse,
  type LoyaltyProgramResponse,
  type LoyaltyRewardResponse,
  type LoyaltyTiersResponse,
  type LoyaltyTransactionResponse,
} from './loyalty.responses';
import {
  adjustLoyaltyBalanceSchema,
  cancelLoyaltyCouponSchema,
  createLoyaltyRewardSchema,
  listLoyaltyRewardsSchema,
  listLoyaltyTransactionsSchema,
  redeemLoyaltyRewardSchema,
  replaceEarnRulesSchema,
  replaceLoyaltyTiersSchema,
  updateLoyaltyProgramSchema,
  updateLoyaltyRewardSchema,
  type AdjustLoyaltyBalanceInput,
  type CancelLoyaltyCouponInput,
  type CreateLoyaltyRewardInput,
  type ListLoyaltyRewardsQuery,
  type ListLoyaltyTransactionsQuery,
  type RedeemLoyaltyRewardInput,
  type ReplaceEarnRulesInput,
  type ReplaceLoyaltyTiersInput,
  type UpdateLoyaltyProgramInput,
  type UpdateLoyaltyRewardInput,
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

  @Get('loyalty/tiers')
  @ApiOperation({
    summary: 'Client tiers (Standard / Silver / Gold / VIP — names are the salon’s)',
  })
  @ApiZodResponse(loyaltyTiersSchema)
  getTiers(@CurrentMembership() m: MembershipContext): Promise<LoyaltyTiersResponse> {
    return this.loyalty.getTiers(m);
  }

  @Put('loyalty/tiers')
  @ApiOperation({
    summary: 'Replace the client tiers: measured by paid visits or spend over the last periodDays',
    description: 'An empty list switches tiers off. Thresholds must differ.',
  })
  @ApiZodBody(replaceLoyaltyTiersSchema)
  @ApiZodResponse(loyaltyTiersSchema)
  replaceTiers(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Body(new ZodValidationPipe(replaceLoyaltyTiersSchema)) body: ReplaceLoyaltyTiersInput,
  ): Promise<LoyaltyTiersResponse> {
    return this.loyalty.replaceTiers(m, auth.userId, body);
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

  @Get('loyalty/rewards')
  @ApiOperation({ summary: 'The salon’s reward catalogue, cheapest first within sortOrder' })
  @ApiQuery({ name: 'includeArchived', required: false, enum: ['true', 'false'] })
  @ApiZodResponse(loyaltyRewardListSchema)
  listRewards(
    @CurrentMembership() m: MembershipContext,
    @Query(new ZodValidationPipe(listLoyaltyRewardsSchema)) query: ListLoyaltyRewardsQuery,
  ): Promise<LoyaltyRewardResponse[]> {
    return this.loyalty.listRewards(m, query);
  }

  @Post('loyalty/rewards')
  @ApiOperation({
    summary: 'Add a reward: a discount in % or a free service, for stamps or points',
  })
  @ApiZodBody(createLoyaltyRewardSchema)
  @ApiZodResponse(loyaltyRewardSchema, HttpStatus.CREATED)
  createReward(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Body(new ZodValidationPipe(createLoyaltyRewardSchema)) body: CreateLoyaltyRewardInput,
  ): Promise<LoyaltyRewardResponse> {
    return this.loyalty.createReward(m, auth.userId, body);
  }

  @Put('loyalty/rewards/:rewardId')
  @ApiOperation({
    summary: 'Change a reward. Coupons already taken keep their terms. Send the version you read',
  })
  @ApiZodBody(updateLoyaltyRewardSchema)
  @ApiZodResponse(loyaltyRewardSchema)
  updateReward(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('rewardId', uuid('Reward')) rewardId: string,
    @Body(new ZodValidationPipe(updateLoyaltyRewardSchema)) body: UpdateLoyaltyRewardInput,
  ): Promise<LoyaltyRewardResponse> {
    return this.loyalty.updateReward(m, auth.userId, rewardId, body);
  }

  @Delete('loyalty/rewards/:rewardId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a reward from the catalogue; coupons already taken stay valid' })
  archiveReward(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('rewardId', uuid('Reward')) rewardId: string,
  ): Promise<void> {
    return this.loyalty.archiveReward(m, auth.userId, rewardId);
  }

  @Post('loyalty/accounts/:customerId/redemptions')
  @ApiOperation({
    summary: 'Exchange the client’s stamps or points for a reward; returns the coupon',
    description:
      'Points: the reward’s cost is taken. Stamps: the whole current cycle is taken and the card ' +
      'starts again. 409 LOYALTY_NOT_ENOUGH, 409 LOYALTY_DISABLED.',
  })
  @ApiZodBody(redeemLoyaltyRewardSchema)
  @ApiZodResponse(loyaltyCouponSchema, HttpStatus.CREATED)
  redeem(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('customerId', uuid('Customer')) customerId: string,
    @Body(new ZodValidationPipe(redeemLoyaltyRewardSchema)) body: RedeemLoyaltyRewardInput,
  ): Promise<LoyaltyCouponResponse> {
    return this.loyalty.redeem(m, auth.userId, customerId, body);
  }

  @Post('loyalty/accounts/:customerId/adjustments')
  @ApiOperation({
    summary: 'Correct a client’s balance by hand, with a reason (shown in the history)',
    description: '409 LOYALTY_NOT_ENOUGH when it would take the balance below zero.',
  })
  @ApiZodBody(adjustLoyaltyBalanceSchema)
  @ApiZodResponse(loyaltyAccountSchema, HttpStatus.CREATED)
  adjust(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('customerId', uuid('Customer')) customerId: string,
    @Body(new ZodValidationPipe(adjustLoyaltyBalanceSchema)) body: AdjustLoyaltyBalanceInput,
  ): Promise<LoyaltyAccountResponse> {
    return this.loyalty.adjust(m, auth.userId, customerId, body);
  }

  @Post('loyalty/coupons/:couponId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel an unused coupon; its stamps or points go back to the client',
    description: '409 COUPON_NOT_ACTIVE when it was already used or cancelled.',
  })
  @ApiZodBody(cancelLoyaltyCouponSchema)
  @ApiZodResponse(loyaltyCouponSchema)
  cancelCoupon(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('couponId', uuid('Coupon')) couponId: string,
    @Body(new ZodValidationPipe(cancelLoyaltyCouponSchema)) body: CancelLoyaltyCouponInput,
  ): Promise<LoyaltyCouponResponse> {
    return this.loyalty.cancelCoupon(m, auth.userId, couponId, body);
  }
}
