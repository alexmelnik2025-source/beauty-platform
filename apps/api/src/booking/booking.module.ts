import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AppointmentWriter } from './appointment-writer';
import { AppointmentsController, CustomersController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { CustomersService } from './customers.service';
import { OutboxService } from './outbox.service';
import { PublicBookingController } from './public-booking.controller';
import { PublicBookingService } from './public-booking.service';

@Module({
  imports: [OrganizationsModule, SchedulingModule],
  controllers: [PublicBookingController, AppointmentsController, CustomersController],
  providers: [
    AppointmentWriter,
    AppointmentsService,
    CustomersService,
    OutboxService,
    PublicBookingService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [OutboxService],
})
export class BookingModule {}
