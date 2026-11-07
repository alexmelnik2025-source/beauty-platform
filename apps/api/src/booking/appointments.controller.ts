import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentAuth } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { Idempotent } from '../common/idempotency.interceptor';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import type { AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  applyVisitCouponSchema,
  removeVisitCouponSchema,
  setPaidSchema,
  setTipSchema,
  type ApplyVisitCouponInput,
  type RemoveVisitCouponInput,
  type SetPaidInput,
  type SetTipInput,
} from '../loyalty/loyalty.schemas';
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../organizations/membership.guard';
import {
  AppointmentsService,
  type AppointmentDetailResponse,
  type AppointmentResponse,
  type VisitCouponsResponse,
} from './appointments.service';
import {
  appointmentDetailSchema,
  appointmentListSchema,
  customerDetailSchema,
  customerListSchema,
  customerTagsSchema,
  visitCouponsSchema,
  type CustomerTagsResponse,
} from './booking.responses';
import {
  approveSchema,
  cancelSchema,
  createAppointmentSchema,
  createCustomerSchema,
  listAppointmentsSchema,
  listCustomersSchema,
  rescheduleSchema,
  setStatusSchema,
  updateCustomerSchema,
  type ApproveInput,
  type CancelInput,
  type CreateAppointmentInput,
  type CreateCustomerInput,
  type ListAppointmentsQuery,
  type ListCustomersQuery,
  type RescheduleInput,
  type SetStatusInput,
  type UpdateCustomerInput,
} from './booking.schemas';
import {
  CustomersService,
  type CustomerDetailResponse,
  type CustomerResponse,
} from './customers.service';
import {
  CustomersExportService,
  exportCustomersSchema,
  type ExportCustomersQuery,
} from './customers-export';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

@ApiTags('appointments')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/appointments')
@UseGuards(MembershipGuard)
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  @ApiOperation({
    summary: 'Calendar: appointments between two local dates (max 42 days)',
    description: 'Staff members (role "staff") only see their own appointments.',
  })
  @ApiQuery({ name: 'from', example: '2026-11-02' })
  @ApiQuery({ name: 'to', example: '2026-11-08' })
  @ApiQuery({ name: 'staffId', required: false })
  @ApiZodResponse(appointmentListSchema)
  list(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Query(new ZodValidationPipe(listAppointmentsSchema)) query: ListAppointmentsQuery,
  ): Promise<AppointmentResponse[]> {
    return this.appointments.list(m, auth.userId, locationId, query);
  }

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Book on behalf of a client (phone, walk-in)',
    description:
      'start: ISO instant on a 5-minute mark. Outside working hours → 409 OUTSIDE_WORKING_HOURS unless allowOutsideHours=true. Never over another booking. A walk-in entered afterwards: alreadyHappened=true (start today or yesterday in salon time, not in the future; saved as "came", no emails to the client; working hours are not checked) and optionally paid=true (loyalty earned). Older → 400 TOO_LONG_AGO, future → 400 NOT_STARTED.',
  })
  @ApiZodBody(createAppointmentSchema)
  @ApiZodResponse(appointmentDetailSchema, HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(createAppointmentSchema)) body: CreateAppointmentInput,
  ): Promise<AppointmentDetailResponse> {
    return this.appointments.create(m, auth.userId, locationId, body);
  }

  @Get(':appointmentId')
  @ApiOperation({ summary: 'One appointment with its history' })
  @ApiZodResponse(appointmentDetailSchema)
  get(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
  ): Promise<AppointmentDetailResponse> {
    return this.appointments.get(m, auth.userId, locationId, appointmentId);
  }

  @Post(':appointmentId/reschedule')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({ summary: 'Move to another time or staff member. Send the version you read' })
  @ApiZodBody(rescheduleSchema)
  @ApiZodResponse(appointmentDetailSchema)
  reschedule(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Body(new ZodValidationPipe(rescheduleSchema)) body: RescheduleInput,
  ): Promise<AppointmentDetailResponse> {
    return this.appointments.reschedule(m, auth.userId, locationId, appointmentId, body);
  }

  @Post(':appointmentId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel with a reason; the client gets an email' })
  @ApiZodBody(cancelSchema)
  @ApiZodResponse(appointmentDetailSchema)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Body(new ZodValidationPipe(cancelSchema)) body: CancelInput,
  ): Promise<AppointmentDetailResponse> {
    return this.appointments.cancel(m, auth.userId, locationId, appointmentId, body);
  }

  @Post(':appointmentId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Accept a visit that waits for the salon (task 161b); the client gets the confirmation',
    description:
      '409 NOT_AWAITING_APPROVAL: the visit does not wait (already accepted or cancelled). ' +
      'To refuse it, cancel it with a reason.',
  })
  @ApiZodBody(approveSchema)
  @ApiZodResponse(appointmentDetailSchema)
  approve(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Body(new ZodValidationPipe(approveSchema)) body: ApproveInput,
  ): Promise<AppointmentDetailResponse> {
    return this.appointments.approve(m, auth.userId, locationId, appointmentId, body);
  }

  @Post(':appointmentId/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark "came" (completed) or "did not come" (no_show)' })
  @ApiZodBody(setStatusSchema)
  @ApiZodResponse(appointmentDetailSchema)
  setStatus(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Body(new ZodValidationPipe(setStatusSchema)) body: SetStatusInput,
  ): Promise<AppointmentDetailResponse> {
    return this.appointments.setStatus(m, auth.userId, locationId, appointmentId, body);
  }

  @Post(':appointmentId/payment')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark a "came" visit as paid (earns loyalty) or not paid (refund: takes it back)',
    description:
      '409 NOT_COMPLETED: only completed visits can be paid. Repeating the same mark changes nothing.',
  })
  @ApiZodBody(setPaidSchema)
  @ApiZodResponse(appointmentDetailSchema)
  setPaid(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Body(new ZodValidationPipe(setPaidSchema)) body: SetPaidInput,
  ): Promise<AppointmentDetailResponse> {
    return this.appointments.setPaid(m, auth.userId, locationId, appointmentId, body);
  }

  @Put(':appointmentId/tip')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Note the tip the client left on a "came" visit (0 = none)',
    description:
      'Task 229: only a note for the report and the till; not part of the revenue. 409 NOT_COMPLETED: only completed visits. Who may mark the visit paid may note the tip.',
  })
  @ApiZodBody(setTipSchema)
  @ApiZodResponse(appointmentDetailSchema)
  setTip(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Body(new ZodValidationPipe(setTipSchema)) body: SetTipInput,
  ): Promise<AppointmentDetailResponse> {
    return this.appointments.setTip(m, auth.userId, locationId, appointmentId, body);
  }

  @Get(':appointmentId/coupons')
  @ApiOperation({
    summary: "Loyalty coupons on the visit and the client's other unused coupons",
    description:
      'For each unused coupon: what it would take off this visit, or why it cannot be used (problem). Who may change the visit may see this.',
  })
  @ApiZodResponse(visitCouponsSchema)
  coupons(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
  ): Promise<VisitCouponsResponse> {
    return this.appointments.coupons(m, auth.userId, locationId, appointmentId);
  }

  @Post(':appointmentId/coupons')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Use the client's loyalty coupon on the visit (lowers its price)",
    description:
      'couponId from the list, or the code the client shows. Only a booked or "came" visit that is not paid (409 VISIT_NOT_CHANGEABLE). The salon\'s rules: 409 COUPON_NOT_FOR_SERVICE, COUPON_NOT_COMBINABLE (one discount per visit), COUPON_NO_DISCOUNT (maximum discount reached), COUPON_EXPIRED, COUPON_NOT_ACTIVE. Another client\'s coupon → 404.',
  })
  @ApiZodBody(applyVisitCouponSchema)
  @ApiZodResponse(appointmentDetailSchema)
  applyCoupon(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Body(new ZodValidationPipe(applyVisitCouponSchema)) body: ApplyVisitCouponInput,
  ): Promise<AppointmentDetailResponse> {
    return this.appointments.applyCoupon(m, auth.userId, locationId, appointmentId, body);
  }

  @Post(':appointmentId/tier-discount')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Use the client's tier discount on the visit (lowers its price)",
    description:
      'The client\'s tier in the salon now (task 10e), by the same rules as coupons: 409 COUPON_NOT_COMBINABLE (one discount per visit), COUPON_NO_DISCOUNT (maximum discount reached), COUPON_NOT_ACTIVE (already used), TIER_NO_DISCOUNT (no tier with a discount). Only a booked or "came" visit that is not paid (409 VISIT_NOT_CHANGEABLE).',
  })
  @ApiZodBody(removeVisitCouponSchema)
  @ApiZodResponse(appointmentDetailSchema)
  applyTierDiscount(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Body(new ZodValidationPipe(removeVisitCouponSchema)) body: RemoveVisitCouponInput,
  ): Promise<AppointmentDetailResponse> {
    return this.appointments.applyTierDiscount(m, auth.userId, locationId, appointmentId, body);
  }

  @Post(':appointmentId/tier-discount/remove')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Take the tier discount off a visit that is not paid yet' })
  @ApiZodBody(removeVisitCouponSchema)
  @ApiZodResponse(appointmentDetailSchema)
  removeTierDiscount(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Body(new ZodValidationPipe(removeVisitCouponSchema)) body: RemoveVisitCouponInput,
  ): Promise<AppointmentDetailResponse> {
    return this.appointments.removeTierDiscount(m, auth.userId, locationId, appointmentId, body);
  }

  @Post(':appointmentId/coupons/:couponId/remove')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take a coupon off a visit that is not paid yet; the client can use it again',
  })
  @ApiZodBody(removeVisitCouponSchema)
  @ApiZodResponse(appointmentDetailSchema)
  removeCoupon(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Param('couponId', uuid('Coupon')) couponId: string,
    @Body(new ZodValidationPipe(removeVisitCouponSchema)) body: RemoveVisitCouponInput,
  ): Promise<AppointmentDetailResponse> {
    return this.appointments.removeCoupon(
      m,
      auth.userId,
      locationId,
      appointmentId,
      couponId,
      body,
    );
  }
}

@ApiTags('customers')
@ApiBearerAuth()
@Controller('organizations/:orgId/customers')
@UseGuards(MembershipGuard)
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly exporter: CustomersExportService,
  ) {}

  @Get()
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'Clients (search by name, phone or email)' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({
    name: 'inactiveDays',
    required: false,
    description:
      'Task 140: only clients who came before but not in the last N days (14–730) and have nothing booked ahead',
  })
  @ApiQuery({
    name: 'tag',
    required: false,
    description: 'Task 224: only clients with this label (exactly as written in the card)',
  })
  @ApiQuery({
    name: 'marketing',
    required: false,
    enum: ['yes'],
    description:
      'Task 245: only clients whose latest answer about the salon messages is "yes" (empty without the permission to see client contacts)',
  })
  @ApiQuery({
    name: 'newDays',
    required: false,
    description:
      'Task 248: only clients whose first visit that took place was in the last N days (7–90), newest first',
  })
  @ApiQuery({
    name: 'overdue',
    required: false,
    enum: ['yes'],
    description:
      'Task 262: only clients past their usual time to come back (from three visits) with nothing booked ahead, the most recently due first',
  })
  @ApiQuery({
    name: 'noShows',
    required: false,
    enum: ['yes'],
    description:
      'Task 264: only clients who did not come (no-show) at least once in the last 365 days, the most recent no-show first',
  })
  @ApiQuery({
    name: 'once',
    required: false,
    enum: ['yes'],
    description:
      'Task 270: only clients who came once (one day with visits that took place, 30–365 days ago) with nothing booked ahead, the most recent first',
  })
  @ApiZodResponse(customerListSchema)
  list(
    @CurrentMembership() m: MembershipContext,
    @Query(new ZodValidationPipe(listCustomersSchema)) query: ListCustomersQuery,
  ): Promise<CustomerResponse[]> {
    return this.customers.list(m, query);
  }

  @Post()
  @Idempotent()
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Add a client',
    description:
      '409 CUSTOMER_EMAIL_EXISTS / CUSTOMER_PHONE_EXISTS with the existing client id in details; send allowDuplicatePhone=true to add anyway.',
  })
  @ApiZodBody(createCustomerSchema)
  @ApiZodResponse(customerDetailSchema, HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Body(new ZodValidationPipe(createCustomerSchema)) body: CreateCustomerInput,
  ): Promise<CustomerDetailResponse> {
    return this.customers.create(m, auth.userId, body);
  }

  @Get('export.csv')
  @RequireRoles('owner')
  @ApiOperation({
    summary: 'All clients as a CSV file (owners only)',
    description:
      'Semicolon-separated, UTF-8 with a byte order mark (opens in Excel). Every export is written to the audit log.',
  })
  @ApiQuery({ name: 'lang', required: false, enum: ['pl', 'uk', 'ru', 'en'] })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'The CSV file', schema: { type: 'string' } })
  async exportCsv(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Query(new ZodValidationPipe(exportCustomersSchema)) query: ExportCustomersQuery,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.exporter.csv(m, auth.userId, query);
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="klienci-${day}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(csv);
  }

  @Get('tags')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Labels of the clients, with how many clients have each',
    description:
      'Task 224: for the label filter above the client list. Empty without the permission to see notes and tags.',
  })
  @ApiZodResponse(customerTagsSchema)
  tags(@CurrentMembership() m: MembershipContext): Promise<CustomerTagsResponse> {
    return this.customers.tags(m);
  }

  @Get(':customerId')
  @ApiOperation({
    summary: 'One client card with visit history',
    description:
      'Staff members: clients they have (had) an appointment with; contacts, history and notes depend on their permissions.',
  })
  @ApiZodResponse(customerDetailSchema)
  get(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('customerId', uuid('Customer')) customerId: string,
  ): Promise<CustomerDetailResponse> {
    return this.customers.get(m, auth.userId, customerId);
  }

  @Patch(':customerId')
  @ApiOperation({
    summary: 'Edit a client. Send the version you read',
    description: 'Staff members with editClientNotes may change only note and tags.',
  })
  @ApiZodBody(updateCustomerSchema)
  @ApiZodResponse(customerDetailSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('customerId', uuid('Customer')) customerId: string,
    @Body(new ZodValidationPipe(updateCustomerSchema)) body: UpdateCustomerInput,
  ): Promise<CustomerDetailResponse> {
    return this.customers.update(m, auth.userId, customerId, body);
  }
}
