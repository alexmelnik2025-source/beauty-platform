import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PublicVouchersController } from './public-vouchers.controller';
import { VisitVouchersController, VouchersController } from './vouchers.controller';
import { VouchersService } from './vouchers.service';

/** Task 490: "Bony podarunkowe". */
@Module({
  imports: [OrganizationsModule, BookingModule],
  controllers: [VouchersController, VisitVouchersController, PublicVouchersController],
  providers: [VouchersService],
})
export class VouchersModule {}
