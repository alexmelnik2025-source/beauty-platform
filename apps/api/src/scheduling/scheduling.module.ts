import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AvailabilityService } from './availability.service';
import { CatalogService } from './catalog.service';
import {
  LocationPhotosController,
  PublicPhotosController,
  StaffPhotoController,
} from './photos.controller';
import { PhotosService } from './photos.service';
import { PublicLocationsController } from './public.controller';
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
    LocationPhotosController,
    StaffPhotoController,
    PublicPhotosController,
  ],
  providers: [CatalogService, ScheduleService, AvailabilityService, PhotosService],
  exports: [AvailabilityService],
})
export class SchedulingModule {}
