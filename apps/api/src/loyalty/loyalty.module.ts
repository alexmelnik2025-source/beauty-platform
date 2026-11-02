import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyLedger } from './loyalty-ledger';
import { LoyaltyService } from './loyalty.service';

@Module({
  imports: [OrganizationsModule],
  controllers: [LoyaltyController],
  providers: [LoyaltyService, LoyaltyLedger],
  exports: [LoyaltyLedger],
})
export class LoyaltyModule {}
