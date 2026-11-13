import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { CommissionsService } from './commissions.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { TillCloseService } from './till-close.service';

@Module({
  imports: [OrganizationsModule],
  controllers: [ReportsController],
  providers: [ReportsService, TillCloseService, CommissionsService],
})
export class ReportsModule {}
