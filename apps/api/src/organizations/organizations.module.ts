import { Module } from '@nestjs/common';
import { MembershipGuard } from './membership.guard';
import { LocationsController, OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({
  controllers: [OrganizationsController, LocationsController],
  providers: [OrganizationsService, MembershipGuard],
})
export class OrganizationsModule {}
