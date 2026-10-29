import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentAuth } from '../auth/decorators';
import { OutboxService, type FailedEmail, type OutboxStats } from '../booking/outbox.service';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import type { AuthContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PlatformAdminGuard } from './platform-admin.guard';
import { emailsRequeuedSchema, failedEmailListSchema, outboxStatsSchema } from './admin.responses';

export const retryEmailsSchema = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(500) }),
  z.object({ all: z.literal(true) }),
]);
type RetryEmailsInput = z.infer<typeof retryEmailsSchema>;

@ApiTags('platform admin')
@ApiBearerAuth()
@Controller('admin/outbox')
@UseGuards(PlatformAdminGuard)
export class AdminOutboxController {
  private readonly logger = new Logger('Admin');

  constructor(private readonly outbox: OutboxService) {}

  @Get()
  @ApiOperation({ summary: 'Email queue health: waiting, failed, sent in the last 24 h' })
  @ApiZodResponse(outboxStatsSchema)
  stats(): Promise<OutboxStats> {
    return this.outbox.stats();
  }

  @Get('failed')
  @ApiOperation({ summary: 'Emails that were given up on (newest first)' })
  @ApiZodResponse(failedEmailListSchema)
  failed(): Promise<FailedEmail[]> {
    return this.outbox.listFailed();
  }

  @Post('retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send failed emails again: {"ids": [...]} or {"all": true}',
    description:
      'The same idempotency keys are used, so an email the provider already sent is not sent twice.',
  })
  @ApiZodBody(retryEmailsSchema)
  @ApiZodResponse(emailsRequeuedSchema)
  async retry(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(retryEmailsSchema)) body: RetryEmailsInput,
  ): Promise<{ requeued: number }> {
    const requeued = await this.outbox.retryFailed('ids' in body ? body.ids : 'all');
    this.logger.log(`User ${auth.userId} put ${requeued} failed email(s) back in the queue`);
    return { requeued };
  }
}
