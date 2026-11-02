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
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentAuth } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { Idempotent } from '../common/idempotency.interceptor';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import type { AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { setPaidSchema, type SetPaidInput } from '../loyalty/loyalty.schemas';
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../organizations/membership.guard';
import {
  AppointmentsService,
  type AppointmentDetailResponse,
  type AppointmentResponse,
} from './appointments.service';
import {
  appointmentDetailSchema,
  appointmentListSchema,
  customerDetailSchema,
  customerListSchema,
} from './booking.responses';
import {
  cancelSchema,
  createAppointmentSchema,
  createCustomerSchema,
  listAppointmentsSchema,
  listCustomersSchema,
  rescheduleSchema,
  setStatusSchema,
  updateCustomerSchema,
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
      'start: ISO instant on a 5-minute mark. Outside working hours → 409 OUTSIDE_WORKING_HOURS unless allowOutsideHours=true. Never over another booking.',
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
}

@ApiTags('customers')
@ApiBearerAuth()
@Controller('organizations/:orgId/customers')
@UseGuards(MembershipGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'Clients (search by name, phone or email)' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiZodResponse(customerListSchema)
  list(
    @CurrentMembership() m: MembershipContext,
    @Query(new ZodValidationPipe(listCustomersSchema)) query: ListCustomersQuery,
  ): Promise<CustomerResponse[]> {
    return this.customers.list(m, query);
  }

  @Post()
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
