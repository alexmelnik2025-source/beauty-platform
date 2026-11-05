import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Public } from '../auth/decorators';
import { ApiZodBody, ApiZodResponse, responseSchema } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RebookReminderService } from './rebook-reminder.service';

const unsubscribeSchema = z.object({
  token: z.string().min(1).max(200).describe('From the "unsubscribe" link of the email'),
});
type UnsubscribeInput = z.infer<typeof unsubscribeSchema>;

const unsubscribedSchema = responseSchema(
  'Unsubscribed',
  z.strictObject({
    salonName: z.string().describe('The salon that will no longer send such messages'),
  }),
);

/** Task 165c: the one-click "unsubscribe" link of the salon's "time for your next visit" email. */
@ApiTags('public booking')
@Public()
@Controller('public')
export class RebookReminderController {
  constructor(
    private readonly reminders: RebookReminderService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stop the salon’s messages (withdraws the marketing consent)',
    description: '404 NOT_FOUND for a changed or made-up link. Using the link twice is fine.',
  })
  @ApiZodBody(unsubscribeSchema)
  @ApiZodResponse(unsubscribedSchema)
  unsubscribe(
    @Req() req: AppRequest,
    @Body(new ZodValidationPipe(unsubscribeSchema)) body: UnsubscribeInput,
  ): Promise<{ salonName: string }> {
    this.limiter.hit(`unsubscribe:ip:${req.ip}`, 30, 10 * 60_000);
    return this.reminders.unsubscribe(body.token, req.ip ?? null);
  }
}
