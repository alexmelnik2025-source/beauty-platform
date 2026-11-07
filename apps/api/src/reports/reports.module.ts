import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { TillCloseService } from './till-close.service';

@Module({
  imports: [OrganizationsModule],
  controllers: [ReportsController],
  providers: [ReportsService, TillCloseService],
})
export class ReportsModule {}
