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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentAuth, Public } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest, AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  createInvitationSchema,
  InvitationsService,
  type CreateInvitationInput,
  type InvitationAcceptedResponse,
  type InvitationPreviewResponse,
  type InvitationResponse,
} from './invitations.service';
import { CurrentMembership, MembershipGuard, RequireRoles } from './membership.guard';
import {
  invitationAcceptedSchema,
  invitationListSchema,
  invitationPreviewSchema,
  invitationSchema,
} from './team.responses';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

@ApiTags('team and permissions')
@ApiBearerAuth()
@Controller('organizations/:orgId')
@UseGuards(MembershipGuard)
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('invitations')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Invite a manager or staff member by email',
    description:
      'Managers may invite staff to their own locations only. Inviting the same email again cancels the previous link.',
  })
  @ApiZodBody(createInvitationSchema)
  @ApiZodResponse(invitationSchema, HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Body(new ZodValidationPipe(createInvitationSchema)) body: CreateInvitationInput,
  ): Promise<InvitationResponse> {
    return this.invitations.create(m, auth.userId, body);
  }

  @Get('invitations')
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'Invitations of the last 30 days' })
  @ApiZodResponse(invitationListSchema)
  list(@CurrentMembership() m: MembershipContext): Promise<InvitationResponse[]> {
    return this.invitations.list(m);
  }

  @Delete('invitations/:invitationId')
  @RequireRoles('owner', 'manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancel an invitation; its link stops working' })
  revoke(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('invitationId', uuid('Invitation')) invitationId: string,
  ): Promise<void> {
    return this.invitations.revoke(m, auth.userId, invitationId);
  }

  @Delete('members/:membershipId')
  @RequireRoles('owner')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a manager or staff member (owner)',
    description: 'Access ends at once. Their staff profile and appointments stay in the calendar.',
  })
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('membershipId', uuid('Member')) membershipId: string,
  ): Promise<void> {
    return this.invitations.removeMember(m, auth.userId, membershipId);
  }
}

@ApiTags('team and permissions')
@Controller('invitations')
export class AcceptInvitationController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Get(':token')
  @Public()
  @ApiOperation({ summary: 'What an invitation link is for (before signing in)' })
  @ApiZodResponse(invitationPreviewSchema)
  preview(
    @Req() req: AppRequest,
    @Param('token') token: string,
  ): Promise<InvitationPreviewResponse> {
    this.limiter.hit(`invitation:ip:${req.ip}`, 30, 10 * 60_000);
    return this.invitations.preview(token);
  }

  @Post(':token/accept')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Join the team (signed in with the invited, verified email)',
  })
  @ApiZodResponse(invitationAcceptedSchema)
  accept(
    @Req() req: AppRequest,
    @CurrentAuth() auth: AuthContext,
    @Param('token') token: string,
  ): Promise<InvitationAcceptedResponse> {
    this.limiter.hit(`invitation:ip:${req.ip}`, 30, 10 * 60_000);
    return this.invitations.accept(auth.userId, token);
  }
}
