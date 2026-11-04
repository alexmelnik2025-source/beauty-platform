import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AvailabilityService } from './availability.service';
import { CatalogService } from './catalog.service';
import { HappyHoursController } from './happy-hours.controller';
import { HappyHoursService } from './happy-hours';
import {
  LocationPhotosController,
  PublicPhotosController,
  StaffPhotoController,
} from './photos.controller';
import { PhotosService } from './photos.service';
import { PublicLocationsController } from './public.controller';
import { PublicDirectoryController } from './public-directory.controller';
import { ScheduleService } from './schedule.service';
import {
  AvailabilityController,
  ServiceCategoriesController,
  ServicesController,
  StaffController,
} from './scheduling.controller';

@Module({
  imports: [OrganizationsModule],
  controllers: [
    ServiceCategoriesController,
    ServicesController,
    StaffController,
    AvailabilityController,
    PublicLocationsController,
    PublicDirectoryController,
    LocationPhotosController,
    StaffPhotoController,
    PublicPhotosController,
    HappyHoursController,
  ],
  providers: [
    CatalogService,
    ScheduleService,
    AvailabilityService,
    PhotosService,
    HappyHoursService,
  ],
  exports: [AvailabilityService, HappyHoursService],
})
export class SchedulingModule {}
