import { Module } from '@nestjs/common';
import { AcceptInvitationController, InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { LocationAccessService } from './location-access.service';
import { MembershipGuard } from './membership.guard';
import { LocationsController, OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';

@Module({
  controllers: [
    OrganizationsController,
    LocationsController,
    PermissionsController,
    InvitationsController,
    AcceptInvitationController,
  ],
  providers: [
    OrganizationsService,
    PermissionsService,
    InvitationsService,
    MembershipGuard,
    LocationAccessService,
  ],
  exports: [MembershipGuard, LocationAccessService, InvitationsService],
})
export class OrganizationsModule {}
