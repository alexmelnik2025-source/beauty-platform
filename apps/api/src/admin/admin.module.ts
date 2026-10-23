import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { AdminOutboxController } from './admin.controller';
import { PlatformAdminGuard } from './platform-admin.guard';

@Module({
  imports: [BookingModule],
  controllers: [AdminOutboxController],
  providers: [PlatformAdminGuard],
})
export class AdminModule {}
