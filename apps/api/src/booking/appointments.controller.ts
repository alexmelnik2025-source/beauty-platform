import {
  Body,
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
import { Idempotent } from '../common/idempotency.interceptor';
import { ApiZodBody } from '../common/openapi';
import type { AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentMembership, MembershipGuard, RequireRoles } from '../organizations/membership.guard';
import {
  AppointmentsService,
  type AppointmentDetailResponse,
  type AppointmentResponse,
} from './appointments.service';
import {
  cancelSchema,
  createAppointmentSchema,
  listAppointmentsSchema,
  listCustomersSchema,
  rescheduleSchema,
  setStatusSchema,
  type CancelInput,
  type CreateAppointmentInput,
  type ListAppointmentsQuery,
  type ListCustomersQuery,
  type RescheduleInput,
  type SetStatusInput,
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
  setStatus(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
    @Body(new ZodValidationPipe(setStatusSchema)) body: SetStatusInput,
  ): Promise<AppointmentDetailResponse> {
    return this.appointments.setStatus(m, auth.userId, locationId, appointmentId, body);
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
  list(
    @CurrentMembership() m: MembershipContext,
    @Query(new ZodValidationPipe(listCustomersSchema)) query: ListCustomersQuery,
  ): Promise<CustomerResponse[]> {
    return this.customers.list(m, query);
  }

  @Get(':customerId')
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'One client with visit history' })
  get(
    @CurrentMembership() m: MembershipContext,
    @Param('customerId', uuid('Customer')) customerId: string,
  ): Promise<CustomerDetailResponse> {
    return this.customers.get(m, customerId);
  }
}
