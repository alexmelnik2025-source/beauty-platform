import { staffLanguagesSchema, type StaffLanguagesInput } from './scheduling.schemas';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../organizations/membership.guard';
import { AvailabilityService, type AvailabilityResponse } from './availability.service';
import {
  CatalogService,
  type ServiceCategoryResponse,
  type ServiceResponse,
  type StaffResponse,
} from './catalog.service';
import { availabilitySchema } from './public.responses';
import {
  ScheduleService,
  type TimeOffResponse,
  type WorkingHoursResponse,
} from './schedule.service';
import {
  availabilityQuerySchema,
  createServiceCategorySchema,
  createServiceSchema,
  createStaffSchema,
  createTimeOffSchema,
  localDateSchema,
  overrideSchema,
  serviceStaffSchema,
  serviceCategoryOrderSchema,
  staffServicesSchema,
  updateServiceCategorySchema,
  updateServiceSchema,
  updateStaffSchema,
  weeklyHoursSchema,
  type AvailabilityQuery,
  type CreateServiceCategoryInput,
  type CreateServiceInput,
  type CreateStaffInput,
  type CreateTimeOffInput,
  type OverrideInput,
  type UpdateServiceCategoryInput,
  type UpdateServiceInput,
  type UpdateStaffInput,
  type WeeklyHoursInput,
} from './scheduling.schemas';
import {
  serviceCategoryListSchema,
  serviceCategorySchema,
  serviceListSchema,
  serviceSchema,
  staffListSchema,
  staffSchema,
  timeOffListSchema,
  timeOffSchema,
  workingHoursSchema,
} from './scheduling.responses';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });
const datePipe = new ZodValidationPipe(localDateSchema);

@ApiTags('services')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/service-categories')
@UseGuards(MembershipGuard)
export class ServiceCategoriesController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @ApiOperation({ summary: 'Service categories of the price list, in display order' })
  @ApiZodResponse(serviceCategoryListSchema)
  list(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<ServiceCategoryResponse[]> {
    return this.catalog.listCategories(m, locationId);
  }

  @Post()
  @Idempotent()
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'Create a category' })
  @ApiZodBody(createServiceCategorySchema)
  @ApiZodResponse(serviceCategorySchema, HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(createServiceCategorySchema)) body: CreateServiceCategoryInput,
  ): Promise<ServiceCategoryResponse> {
    return this.catalog.createCategory(m, auth.userId, locationId, body);
  }

  @Put('order')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Set the order of the categories on the booking page and in the apps (task 254)',
    description:
      'Send every category of the location exactly once, first to last. Replaces sortOrder.',
  })
  @ApiZodBody(serviceCategoryOrderSchema)
  @ApiZodResponse(serviceCategoryListSchema)
  reorder(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(serviceCategoryOrderSchema)) body: { categoryIds: string[] },
  ): Promise<ServiceCategoryResponse[]> {
    return this.catalog.reorderCategories(m, auth.userId, locationId, body.categoryIds);
  }

  @Patch(':serviceCategoryId')
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'Rename or reorder a category. Send the version you read' })
  @ApiZodBody(updateServiceCategorySchema)
  @ApiZodResponse(serviceCategorySchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('serviceCategoryId', uuid('Category')) categoryId: string,
    @Body(new ZodValidationPipe(updateServiceCategorySchema)) body: UpdateServiceCategoryInput,
  ): Promise<ServiceCategoryResponse> {
    return this.catalog.updateCategory(m, auth.userId, locationId, categoryId, body);
  }

  @Delete(':serviceCategoryId')
  @RequireRoles('owner', 'manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a category; its services stay, without a category' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('serviceCategoryId', uuid('Category')) categoryId: string,
  ): Promise<void> {
    return this.catalog.deleteCategory(m, auth.userId, locationId, categoryId);
  }
}

@ApiTags('services')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/services')
@UseGuards(MembershipGuard)
export class ServicesController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @ApiOperation({ summary: 'Services of the location (incl. inactive)' })
  @ApiZodResponse(serviceListSchema)
  list(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<ServiceResponse[]> {
    return this.catalog.listServices(m, locationId);
  }

  @Post()
  @Idempotent()
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Add a service. Price in hundredths of the location currency (50.00 = 5000)',
  })
  @ApiZodBody(createServiceSchema)
  @ApiZodResponse(serviceSchema, HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(createServiceSchema)) body: CreateServiceInput,
  ): Promise<ServiceResponse> {
    return this.catalog.createService(m, auth.userId, locationId, body);
  }

  @Put('order')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Set the order of the services on the booking page and in the apps (task 252)',
    description:
      'Send every service of the location exactly once, first to last. Replaces sortOrder.',
  })
  @ApiZodBody(staffServicesSchema)
  @ApiZodResponse(serviceListSchema)
  reorder(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(staffServicesSchema)) body: { serviceIds: string[] },
  ): Promise<ServiceResponse[]> {
    return this.catalog.reorderServices(m, auth.userId, locationId, body.serviceIds);
  }

  @Get(':serviceId')
  @ApiOperation({ summary: 'One service' })
  @ApiZodResponse(serviceSchema)
  get(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('serviceId', uuid('Service')) serviceId: string,
  ): Promise<ServiceResponse> {
    return this.catalog.getService(m, locationId, serviceId);
  }

  @Patch(':serviceId')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Update a service; set active=false to hide it. Send the version you read',
  })
  @ApiZodBody(updateServiceSchema)
  @ApiZodResponse(serviceSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('serviceId', uuid('Service')) serviceId: string,
    @Body(new ZodValidationPipe(updateServiceSchema)) body: UpdateServiceInput,
  ): Promise<ServiceResponse> {
    return this.catalog.updateService(m, auth.userId, locationId, serviceId, body);
  }

  @Delete(':serviceId')
  @RequireRoles('owner', 'manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a service that was never used',
    description:
      '409 SERVICE_IN_USE when it has visits (any status) or is in a loyalty reward or coupon — hide it instead (PATCH active=false).',
  })
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('serviceId', uuid('Service')) serviceId: string,
  ): Promise<void> {
    return this.catalog.deleteService(m, auth.userId, locationId, serviceId);
  }

  @Put(':serviceId/staff')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Set which specialists perform this service (replaces the list)',
    description: 'Clients can book a service online only when at least one specialist performs it.',
  })
  @ApiZodBody(serviceStaffSchema)
  @ApiZodResponse(serviceSchema)
  setStaff(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('serviceId', uuid('Service')) serviceId: string,
    @Body(new ZodValidationPipe(serviceStaffSchema)) body: { staffIds: string[] },
  ): Promise<ServiceResponse> {
    return this.catalog.setServiceStaff(m, auth.userId, locationId, serviceId, body.staffIds);
  }
}

@ApiTags('staff')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/staff')
@UseGuards(MembershipGuard)
export class StaffController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly schedule: ScheduleService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Staff of the location' })
  @ApiZodResponse(staffListSchema)
  list(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<StaffResponse[]> {
    return this.catalog.listStaff(m, locationId);
  }

  @Post()
  @Idempotent()
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'Add a staff member (no user account needed)' })
  @ApiZodBody(createStaffSchema)
  @ApiZodResponse(staffSchema, HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(createStaffSchema)) body: CreateStaffInput,
  ): Promise<StaffResponse> {
    return this.catalog.createStaff(m, auth.userId, locationId, body);
  }

  @Get(':staffId')
  @ApiOperation({ summary: 'One staff member' })
  @ApiZodResponse(staffSchema)
  get(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('staffId', uuid('Staff member')) staffId: string,
  ): Promise<StaffResponse> {
    return this.catalog.getStaff(m, locationId, staffId);
  }

  @Patch(':staffId')
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'Update a staff member. Send the version you read' })
  @ApiZodBody(updateStaffSchema)
  @ApiZodResponse(staffSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('staffId', uuid('Staff member')) staffId: string,
    @Body(new ZodValidationPipe(updateStaffSchema)) body: UpdateStaffInput,
  ): Promise<StaffResponse> {
    return this.catalog.updateStaff(m, auth.userId, locationId, staffId, body);
  }

  @Put(':staffId/languages')
  @ApiOperation({
    summary: 'Set the languages a staff member speaks with clients (task 81)',
    description:
      'Owners and managers of the location, or the staff member on their own profile (403 for anyone else).',
  })
  @ApiZodBody(staffLanguagesSchema)
  @ApiZodResponse(staffSchema)
  setLanguages(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('staffId', uuid('Staff member')) staffId: string,
    @Body(new ZodValidationPipe(staffLanguagesSchema)) body: StaffLanguagesInput,
  ): Promise<StaffResponse> {
    return this.catalog.setStaffLanguages(m, auth.userId, locationId, staffId, body.languages);
  }

  @Put(':staffId/services')
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'Set which services this staff member performs (replaces the list)' })
  @ApiZodBody(staffServicesSchema)
  @ApiZodResponse(staffSchema)
  setServices(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('staffId', uuid('Staff member')) staffId: string,
    @Body(new ZodValidationPipe(staffServicesSchema)) body: { serviceIds: string[] },
  ): Promise<StaffResponse> {
    return this.catalog.setStaffServices(m, auth.userId, locationId, staffId, body.serviceIds);
  }

  @Get(':staffId/working-hours')
  @ApiOperation({ summary: 'Weekly hours and upcoming special days (location-local time)' })
  @ApiZodResponse(workingHoursSchema)
  workingHours(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('staffId', uuid('Staff member')) staffId: string,
  ): Promise<WorkingHoursResponse> {
    return this.schedule.getWorkingHours(m, locationId, staffId);
  }

  @Put(':staffId/working-hours')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Replace the weekly hours',
    description:
      'Example: {"days":[{"weekday":1,"intervals":[{"start":"09:00","end":"13:00"},{"start":"14:00","end":"18:00"}]}]}. Weekday 1 = Monday. Days not listed are days off; gaps are breaks.',
  })
  @ApiZodBody(weeklyHoursSchema)
  @ApiZodResponse(workingHoursSchema)
  setWorkingHours(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('staffId', uuid('Staff member')) staffId: string,
    @Body(new ZodValidationPipe(weeklyHoursSchema)) body: WeeklyHoursInput,
  ): Promise<WorkingHoursResponse> {
    return this.schedule.setWeeklyHours(m, auth.userId, locationId, staffId, body);
  }

  @Put(':staffId/working-hours/overrides/:date')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Special hours for one date (YYYY-MM-DD); replace the weekly hours that day',
  })
  @ApiZodBody(overrideSchema)
  @ApiZodResponse(workingHoursSchema)
  setOverride(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('staffId', uuid('Staff member')) staffId: string,
    @Param('date', datePipe) date: string,
    @Body(new ZodValidationPipe(overrideSchema)) body: OverrideInput,
  ): Promise<WorkingHoursResponse> {
    return this.schedule.setOverride(m, auth.userId, locationId, staffId, date, body);
  }

  @Delete(':staffId/working-hours/overrides/:date')
  @RequireRoles('owner', 'manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove special hours for a date' })
  removeOverride(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('staffId', uuid('Staff member')) staffId: string,
    @Param('date', datePipe) date: string,
  ): Promise<void> {
    return this.schedule.removeOverride(m, auth.userId, locationId, staffId, date);
  }

  @Get(':staffId/time-off')
  @ApiOperation({ summary: 'Current and future time off' })
  @ApiZodResponse(timeOffListSchema)
  listTimeOff(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('staffId', uuid('Staff member')) staffId: string,
  ): Promise<TimeOffResponse[]> {
    return this.schedule.listTimeOff(m, locationId, staffId);
  }

  @Post(':staffId/time-off')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Add time off (vacation, sick leave, blocked hours)',
    description:
      'Location-local times, e.g. {"start":"2026-12-24T00:00","end":"2026-12-27T00:00"}.',
  })
  @ApiZodBody(createTimeOffSchema)
  @ApiZodResponse(timeOffSchema, HttpStatus.CREATED)
  addTimeOff(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('staffId', uuid('Staff member')) staffId: string,
    @Body(new ZodValidationPipe(createTimeOffSchema)) body: CreateTimeOffInput,
  ): Promise<TimeOffResponse> {
    return this.schedule.addTimeOff(m, auth.userId, locationId, staffId, body);
  }

  @Delete(':staffId/time-off/:timeOffId')
  @RequireRoles('owner', 'manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove time off' })
  removeTimeOff(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('staffId', uuid('Staff member')) staffId: string,
    @Param('timeOffId', uuid('Time off')) timeOffId: string,
  ): Promise<void> {
    return this.schedule.removeTimeOff(m, auth.userId, locationId, staffId, timeOffId);
  }

  @Put('order')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Set the order of the staff on the booking page, in the apps and the calendar',
    description:
      'Send every staff member of the location exactly once, first to last. Replaces sortOrder.',
  })
  @ApiZodBody(serviceStaffSchema)
  @ApiZodResponse(staffListSchema)
  reorder(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(serviceStaffSchema)) body: { staffIds: string[] },
  ): Promise<StaffResponse[]> {
    return this.catalog.reorderStaff(m, auth.userId, locationId, body.staffIds);
  }
}

@ApiTags('availability')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/availability')
@UseGuards(MembershipGuard)
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  @ApiOperation({
    summary: 'Free start times for a service (for staff booking on behalf of a client)',
    description:
      'No minimum lead time or horizon; only times in the past are excluded. Max 31 days per request.',
  })
  @ApiQuery({ name: 'serviceId', required: true })
  @ApiQuery({ name: 'staffId', required: false, description: 'Omit for "any staff member"' })
  @ApiQuery({ name: 'from', required: true, example: '2026-11-02' })
  @ApiQuery({ name: 'to', required: true, example: '2026-11-08' })
  @ApiZodResponse(availabilitySchema)
  get(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Query(new ZodValidationPipe(availabilityQuerySchema)) query: AvailabilityQuery,
  ): Promise<AvailabilityResponse> {
    return this.availability.forStaff(m, locationId, query);
  }
}
