import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AvailabilityService } from './availability.service';
import { CatalogService } from './catalog.service';
import { PublicLocationsController } from './public.controller';
import { ScheduleService } from './schedule.service';
import {
  AvailabilityController,
  ServicesController,
  StaffController,
} from './scheduling.controller';

@Module({
  imports: [OrganizationsModule],
  controllers: [
    ServicesController,
    StaffController,
    AvailabilityController,
    PublicLocationsController,
  ],
  providers: [CatalogService, ScheduleService, AvailabilityService],
})
export class SchedulingModule {}
