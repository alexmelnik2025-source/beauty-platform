import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { VouchersController } from './vouchers.controller';
import { VouchersService } from './vouchers.service';

/** Task 490: "Bony podarunkowe". */
@Module({
  imports: [OrganizationsModule],
  controllers: [VouchersController],
  providers: [VouchersService],
})
export class VouchersModule {}
