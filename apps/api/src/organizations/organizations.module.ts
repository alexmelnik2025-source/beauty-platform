import { Module } from '@nestjs/common';
import { LocationAccessService } from './location-access.service';
import { MembershipGuard } from './membership.guard';
import { LocationsController, OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';

@Module({
  controllers: [OrganizationsController, LocationsController, PermissionsController],
  providers: [OrganizationsService, PermissionsService, MembershipGuard, LocationAccessService],
  exports: [MembershipGuard, LocationAccessService],
})
export class OrganizationsModule {}
