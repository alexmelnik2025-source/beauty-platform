import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
  createGiftVoucherSchema,
  giftVoucherCodeSchema,
  giftVoucherDetailsSchema,
  giftVoucherListSchema,
  giftVoucherSchema,
  redeemGiftVoucherSchema,
  type CreateGiftVoucherInput,
  type GiftVoucherDetailsResponse,
  type GiftVoucherListResponse,
  type GiftVoucherResponse,
  type RedeemGiftVoucherInput,
} from './vouchers.schemas';
import { VouchersService } from './vouchers.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

/** Task 490: "Bony podarunkowe" — gift vouchers sold at the salon's till. */
@ApiTags('gift-vouchers')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/gift-vouchers')
@UseGuards(MembershipGuard)
export class VouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  @Get()
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'The salon’s gift vouchers, newest first',
    description: 'Task 490. Owners and managers. With what is left on the ones still to be used.',
  })
  @ApiZodResponse(giftVoucherListSchema)
  list(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<GiftVoucherListResponse> {
    return this.vouchers.list(m, locationId);
  }

  @Post()
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: '"Nowy bon": a gift voucher sold at the salon’s till',
    description:
      'Task 490. Owners and managers. The code (8 letters and digits) is made by the server. A last day before today → 400 VOUCHER_DATE_PAST.',
  })
  @ApiZodBody(createGiftVoucherSchema)
  @ApiZodResponse(giftVoucherSchema, HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(createGiftVoucherSchema)) body: CreateGiftVoucherInput,
  ): Promise<GiftVoucherResponse> {
    return this.vouchers.create(m, auth.userId, locationId, body);
  }

  @Get('code/:code')
  @ApiOperation({
    summary: '"Sprawdź bon": a voucher by the code the client shows, with its payments',
    description:
      'Task 490. Everyone in the salon. Letter case, spaces and dashes do not matter. Unknown code → 404.',
  })
  @ApiZodResponse(giftVoucherDetailsSchema)
  byCode(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('code', new ZodValidationPipe(giftVoucherCodeSchema)) code: string,
  ): Promise<GiftVoucherDetailsResponse> {
    return this.vouchers.findByCode(m, locationId, code);
  }

  @Get(':voucherId')
  @ApiOperation({ summary: 'A gift voucher with its payments (everyone in the salon)' })
  @ApiZodResponse(giftVoucherDetailsSchema)
  get(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('voucherId', uuid('Gift voucher')) voucherId: string,
  ): Promise<GiftVoucherDetailsResponse> {
    return this.vouchers.get(m, locationId, voucherId);
  }

  @Post(':voucherId/redeem')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '"Zapłać bonem": take a payment from what is left',
    description:
      'Task 490. Everyone in the salon. In one step, so two payments at the same moment never use more than is left. Cancelled → 409 VOUCHER_CANCELLED; past its last day → 409 VOUCHER_EXPIRED; more than is left → 409 VOUCHER_BALANCE.',
  })
  @ApiZodBody(redeemGiftVoucherSchema)
  @ApiZodResponse(giftVoucherDetailsSchema)
  redeem(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('voucherId', uuid('Gift voucher')) voucherId: string,
    @Body(new ZodValidationPipe(redeemGiftVoucherSchema)) body: RedeemGiftVoucherInput,
  ): Promise<GiftVoucherDetailsResponse> {
    return this.vouchers.redeem(m, auth.userId, locationId, voucherId, body);
  }

  @Post(':voucherId/cancel')
  @RequireRoles('owner', 'manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a gift voucher (sold by mistake, money returned)',
    description: 'Task 490. Owners and managers. It cannot be used afterwards; its payments stay.',
  })
  @ApiZodResponse(giftVoucherSchema)
  cancel(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('voucherId', uuid('Gift voucher')) voucherId: string,
  ): Promise<GiftVoucherResponse> {
    return this.vouchers.cancel(m, locationId, voucherId);
  }
}
