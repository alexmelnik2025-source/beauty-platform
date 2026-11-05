import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { WaitlistController } from './waitlist.controller';
import { WaitlistSalonController } from './waitlist-salon.controller';
import { WaitlistService } from './waitlist.service';

/** Task 50: the waiting list (docs/README.md, "Lista oczekujących"). */
@Module({
  imports: [SchedulingModule, OrganizationsModule, BookingModule],
  controllers: [WaitlistController, WaitlistSalonController],
  providers: [WaitlistService],
  exports: [WaitlistService],
})
export class WaitlistModule {}
