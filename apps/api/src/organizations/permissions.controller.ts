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
  createCategorySchema,
  PermissionsService,
  setMemberPermissionsSchema,
  updateCategorySchema,
  type CategoryResponse,
  type CreateCategoryInput,
  type MemberResponse,
  type PermissionCatalogResponse,
  type SetMemberPermissionsInput,
  type UpdateCategoryInput,
} from './permissions.service';
import {
  memberListSchema,
  memberSchema,
  permissionCatalogSchema,
  staffCategoryListSchema,
  staffCategorySchema,
} from './team.responses';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

@ApiTags('team and permissions')
@ApiBearerAuth()
@Controller('organizations/:orgId')
@UseGuards(MembershipGuard)
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Get('permissions')
  @ApiOperation({
    summary: 'The list of staff permissions with defaults, and what you may do yourself',
  })
  @ApiZodResponse(permissionCatalogSchema)
  catalog(@CurrentMembership() m: MembershipContext): PermissionCatalogResponse {
    return this.permissions.catalog(m);
  }

  @Get('staff-categories')
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'Staff categories ("Senior barber", "Trainee") with their permissions' })
  @ApiZodResponse(staffCategoryListSchema)
  listCategories(@CurrentMembership() m: MembershipContext): Promise<CategoryResponse[]> {
    return this.permissions.listCategories(m);
  }

  @Post('staff-categories')
  @RequireRoles('owner')
  @ApiOperation({ summary: 'Create a staff category (owner)' })
  @ApiZodBody(createCategorySchema)
  @ApiZodResponse(staffCategorySchema, HttpStatus.CREATED)
  createCategory(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryInput,
  ): Promise<CategoryResponse> {
    return this.permissions.createCategory(m, auth.userId, body);
  }

  @Patch('staff-categories/:categoryId')
  @RequireRoles('owner')
  @ApiOperation({ summary: 'Rename a category or change its permissions (owner)' })
  @ApiZodBody(updateCategorySchema)
  @ApiZodResponse(staffCategorySchema)
  updateCategory(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('categoryId', uuid('Category')) categoryId: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryInput,
  ): Promise<CategoryResponse> {
    return this.permissions.updateCategory(m, auth.userId, categoryId, body);
  }

  @Delete('staff-categories/:categoryId')
  @RequireRoles('owner')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a category; its members fall back to the defaults (owner)' })
  deleteCategory(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('categoryId', uuid('Category')) categoryId: string,
  ): Promise<void> {
    return this.permissions.deleteCategory(m, auth.userId, categoryId);
  }

  @Get('members')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'People with access to the organization and their effective permissions',
  })
  @ApiZodResponse(memberListSchema)
  listMembers(@CurrentMembership() m: MembershipContext): Promise<MemberResponse[]> {
    return this.permissions.listMembers(m);
  }

  @Put('members/:membershipId/permissions')
  @RequireRoles('owner')
  @ApiOperation({
    summary: "Set a staff member's category and personal exceptions (owner)",
    description: 'Takes effect on the staff member’s next request, without signing in again.',
  })
  @ApiZodBody(setMemberPermissionsSchema)
  @ApiZodResponse(memberSchema)
  setMemberPermissions(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('membershipId', uuid('Member')) membershipId: string,
    @Body(new ZodValidationPipe(setMemberPermissionsSchema)) body: SetMemberPermissionsInput,
  ): Promise<MemberResponse> {
    return this.permissions.setMemberPermissions(m, auth.userId, membershipId, body);
  }
}
