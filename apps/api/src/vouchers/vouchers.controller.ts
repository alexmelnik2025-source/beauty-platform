import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
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
import { CSV_LOCALES } from '../reports/visits-csv';
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
  type UpdateGiftVoucherInput,
  updateGiftVoucherSchema,
  type VisitVoucherPaymentsResponse,
  visitVoucherPaymentsSchema,
  type VouchersCsvQuery,
  vouchersCsvQuerySchema,
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

  @Get('export.csv')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: '"CSV bonów": every gift voucher of the salon, for the accountant',
    description:
      'Task 494. Owners and managers. One line per voucher, oldest first — code, sold on, sold by, for whom, amount, used, left, valid until, status, note. Same file format as visits-csv.',
  })
  @ApiQuery({ name: 'locale', required: false, enum: CSV_LOCALES })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'The CSV file', schema: { type: 'string' } })
  async csv(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Query(new ZodValidationPipe(vouchersCsvQuerySchema)) query: VouchersCsvQuery,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, fileName } = await this.vouchers.csv(m, locationId, query.locale);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(csv);
  }

  @Get('uses.csv')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: '"CSV płatności bonami": every payment with the salon’s gift vouchers',
    description:
      'Task 533. Owners and managers. One line per payment, oldest first — date, time, voucher code, for whom, amount, paid for, taken by, the day it was undone (empty if not); task 543: the visit it paid for (date and time) and its specialist, empty for a payment at the till. Same file format as visits-csv.',
  })
  @ApiQuery({ name: 'locale', required: false, enum: CSV_LOCALES })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'The CSV file', schema: { type: 'string' } })
  async usesCsv(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Query(new ZodValidationPipe(vouchersCsvQuerySchema)) query: VouchersCsvQuery,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, fileName } = await this.vouchers.usesCsv(m, locationId, query.locale);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(csv);
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
      'Task 490. Everyone in the salon. In one step, so two payments at the same moment never use more than is left. Cancelled → 409 VOUCHER_CANCELLED; past its last day → 409 VOUCHER_EXPIRED; more than is left → 409 VOUCHER_BALANCE. Task 540: with `appointmentId` the payment belongs to that visit (one the member may see, else 404).',
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

  @Post(':voucherId/uses/:useId/undo')
  @RequireRoles('owner', 'manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '"Cofnij płatność": undo a payment with the voucher noted by mistake',
    description:
      'Task 530. Owners and managers. What the payment took goes back to the voucher; the payment stays in the list, marked as undone. Undoing it again changes nothing. A cancelled voucher → 409 VOUCHER_CANCELLED.',
  })
  @ApiZodResponse(giftVoucherDetailsSchema)
  undoUse(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('voucherId', uuid('Gift voucher')) voucherId: string,
    @Param('useId', uuid('Gift voucher payment')) useId: string,
  ): Promise<GiftVoucherDetailsResponse> {
    return this.vouchers.undoUse(m, auth.userId, locationId, voucherId, useId);
  }

  @Patch(':voucherId')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: '"Zmień bon": the last day, who it is for, the note',
    description:
      'Task 498. Owners and managers. Not the amount. A field left out stays; null clears it. A last day before today → 400 VOUCHER_DATE_PAST; a cancelled voucher → 409 VOUCHER_CANCELLED.',
  })
  @ApiZodBody(updateGiftVoucherSchema)
  @ApiZodResponse(giftVoucherSchema)
  update(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('voucherId', uuid('Gift voucher')) voucherId: string,
    @Body(new ZodValidationPipe(updateGiftVoucherSchema)) body: UpdateGiftVoucherInput,
  ): Promise<GiftVoucherResponse> {
    return this.vouchers.update(m, locationId, voucherId, body);
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

/** Task 540: "Zapłacono bonem" in the card of a visit. */
@ApiTags('gift-vouchers')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/appointments/:appointmentId')
@UseGuards(MembershipGuard)
export class VisitVouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  @Get('gift-voucher-payments')
  @ApiOperation({
    summary: 'Payments with gift vouchers for the visit (whoever sees the visit)',
    description:
      'Task 540. Oldest first, undone ones included (marked); the total leaves them out. A payment belongs to a visit when "Zapłać bonem" was given its appointmentId.',
  })
  @ApiZodResponse(visitVoucherPaymentsSchema)
  visitPayments(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
  ): Promise<VisitVoucherPaymentsResponse> {
    return this.vouchers.visitPayments(m, auth.userId, locationId, appointmentId);
  }
}
