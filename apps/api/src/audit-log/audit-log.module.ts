import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AuditLogController } from './audit-log.controller';
import { AuditLogService } from './audit-log.service';

/** Task 23: the owner's "Dziennik zmian". */
@Module({
  imports: [OrganizationsModule],
  controllers: [AuditLogController],
  providers: [AuditLogService],
})
export class AuditLogModule {}
