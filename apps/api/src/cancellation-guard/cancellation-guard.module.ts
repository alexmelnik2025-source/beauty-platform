import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { CancellationGuardController } from './cancellation-guard.controller';
import { CancellationGuardService } from './cancellation-guard.service';

/** Task 161: "Ochrona przed odwołaniami". */
@Module({
  imports: [OrganizationsModule],
  controllers: [CancellationGuardController],
  providers: [CancellationGuardService],
  exports: [CancellationGuardService],
})
export class CancellationGuardModule {}
