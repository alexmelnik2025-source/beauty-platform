import { Module } from '@nestjs/common';
import { LocationAccessService } from './location-access.service';
import { MembershipGuard } from './membership.guard';
import { LocationsController, OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({
  controllers: [OrganizationsController, LocationsController],
  providers: [OrganizationsService, MembershipGuard, LocationAccessService],
  exports: [MembershipGuard, LocationAccessService],
})
export class OrganizationsModule {}
