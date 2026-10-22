import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { RateLimiterService } from './rate-limiter.service';

@Global()
@Module({
  providers: [RateLimiterService, AuditService],
  exports: [RateLimiterService, AuditService],
})
export class CommonModule {}
