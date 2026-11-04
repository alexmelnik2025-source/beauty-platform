import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { WaitlistController } from './waitlist.controller';
import { WaitlistService } from './waitlist.service';

/** Task 50: the waiting list (docs/README.md, "Lista oczekujących"). */
@Module({
  imports: [SchedulingModule],
  controllers: [WaitlistController],
  providers: [WaitlistService],
  exports: [WaitlistService],
})
export class WaitlistModule {}
