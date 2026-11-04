import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AppointmentWriter } from './appointment-writer';
import { AppointmentsController, CustomersController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { CustomersExportService } from './customers-export';
import { CustomerPrivacyController } from './customer-privacy.controller';
import { CustomerPrivacyService } from './customer-privacy.service';
import { CustomersService } from './customers.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { OutboxService } from './outbox.service';
import { PublicBookingController } from './public-booking.controller';
import { PublicBookingService } from './public-booking.service';
import { TimeBlocksController } from './time-blocks.controller';
import { TimeBlocksService } from './time-blocks.service';
import { VisitCalendarController } from './visit-calendar.controller';
import { VisitCalendarService } from './visit-calendar.service';
import {
  AppointmentPhotosController,
  PublicVisitPhotosController,
} from './visit-photos.controller';
import { VisitPhotosService } from './visit-photos.service';

@Module({
  imports: [OrganizationsModule, SchedulingModule, LoyaltyModule],
  controllers: [
    PublicBookingController,
    AppointmentsController,
    CustomersController,
    CustomerPrivacyController,
    TimeBlocksController,
    CalendarController,
    NotificationsController,
    VisitCalendarController,
    PublicVisitPhotosController,
    AppointmentPhotosController,
  ],
  providers: [
    AppointmentWriter,
    AppointmentsService,
    CalendarService,
    CustomerPrivacyService,
    CustomersService,
    CustomersExportService,
    NotificationsService,
    OutboxService,
    PublicBookingService,
    TimeBlocksService,
    VisitCalendarService,
    VisitPhotosService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [
    AppointmentWriter,
    OutboxService,
    PublicBookingService,
    VisitCalendarService,
    VisitPhotosService,
  ],
})
export class BookingModule {}
