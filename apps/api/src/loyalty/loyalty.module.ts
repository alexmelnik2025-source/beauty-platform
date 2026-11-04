import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyLedger } from './loyalty-ledger';
import { LoyaltyService } from './loyalty.service';
import { VisitCoupons } from './visit-coupons';

@Module({
  imports: [OrganizationsModule],
  controllers: [LoyaltyController],
  providers: [LoyaltyService, LoyaltyLedger, VisitCoupons],
  exports: [LoyaltyLedger, VisitCoupons],
})
export class LoyaltyModule {}
