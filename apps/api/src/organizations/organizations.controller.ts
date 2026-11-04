import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentAuth } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import type { AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentMembership, MembershipGuard, RequireRoles } from './membership.guard';
import {
  createLocationSchema,
  createOrganizationSchema,
  updateLocationSchema,
  updateOrganizationSchema,
  type CreateLocationInput,
  type CreateOrganizationInput,
  type UpdateLocationInput,
  type UpdateOrganizationInput,
} from './organizations.schemas';
import {
  legalTemplatesSchema,
  locationListSchema,
  locationSchema,
  organizationListSchema,
  organizationSchema,
} from './organizations.responses';
import {
  OrganizationsService,
  type LegalTemplatesResponse,
  type LocationResponse,
  type OrganizationResponse,
} from './organizations.service';

const locationIdPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Location') });

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post()
  @ApiOperation({ summary: 'Create an organization; you become its owner' })
  @ApiZodBody(createOrganizationSchema)
  @ApiZodResponse(organizationSchema, HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createOrganizationSchema)) body: CreateOrganizationInput,
  ): Promise<OrganizationResponse> {
    return this.organizations.createOrganization(auth.userId, body);
  }

  @Get()
  @ApiOperation({ summary: 'Organizations you belong to' })
  @ApiZodResponse(organizationListSchema)
  list(@CurrentAuth() auth: AuthContext): Promise<OrganizationResponse[]> {
    return this.organizations.listOrganizations(auth.userId);
  }

  @Get(':orgId')
  @UseGuards(MembershipGuard)
  @ApiOperation({ summary: 'One organization (members only)' })
  @ApiZodResponse(organizationSchema)
  get(@CurrentMembership() membership: MembershipContext): Promise<OrganizationResponse> {
    return this.organizations.getOrganization(membership);
  }

  @Patch(':orgId')
  @UseGuards(MembershipGuard)
  @RequireRoles('owner')
  @ApiOperation({ summary: 'Update organization details (owner)' })
  @ApiZodBody(updateOrganizationSchema)
  @ApiZodResponse(organizationSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Body(new ZodValidationPipe(updateOrganizationSchema)) body: UpdateOrganizationInput,
  ): Promise<OrganizationResponse> {
    return this.organizations.updateOrganization(membership, auth.userId, body);
  }
}

@ApiTags('locations')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations')
@UseGuards(MembershipGuard)
export class LocationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post()
  @RequireRoles('owner')
  @ApiOperation({ summary: 'Add a location (owner). Slug is generated from the name if omitted' })
  @ApiZodBody(createLocationSchema)
  @ApiZodResponse(locationSchema, HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Body(new ZodValidationPipe(createLocationSchema)) body: CreateLocationInput,
  ): Promise<LocationResponse> {
    return this.organizations.createLocation(membership, auth.userId, body);
  }

  @Get()
  @ApiOperation({ summary: 'Locations you can access' })
  @ApiZodResponse(locationListSchema)
  list(@CurrentMembership() membership: MembershipContext): Promise<LocationResponse[]> {
    return this.organizations.listLocations(membership);
  }

  @Get(':locationId')
  @ApiOperation({ summary: 'One location' })
  @ApiZodResponse(locationSchema)
  get(
    @CurrentMembership() membership: MembershipContext,
    @Param('locationId', locationIdPipe) locationId: string,
  ): Promise<LocationResponse> {
    return this.organizations.getLocation(membership, locationId);
  }

  @Patch(':locationId')
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'Update a location (owner, or its manager). Send the version you read' })
  @ApiZodBody(updateLocationSchema)
  @ApiZodResponse(locationSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Param('locationId', locationIdPipe) locationId: string,
    @Body(new ZodValidationPipe(updateLocationSchema)) body: UpdateLocationInput,
  ): Promise<LocationResponse> {
    return this.organizations.updateLocation(membership, auth.userId, locationId, body);
  }

  @Get(':locationId/legal-templates')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Templates of the booking terms and privacy policy (owner, or its manager)',
    description:
      'Polish templates with the salon’s name, address, contacts and company filled in. Nothing is saved.',
  })
  @ApiZodResponse(legalTemplatesSchema)
  legalTemplates(
    @CurrentMembership() membership: MembershipContext,
    @Param('locationId', locationIdPipe) locationId: string,
  ): Promise<LegalTemplatesResponse> {
    return this.organizations.legalTemplates(membership, locationId);
  }
}
