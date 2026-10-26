import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentAuth } from '../auth/decorators';
import { ApiZodBody } from '../common/openapi';
import type { AuthContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  PushService,
  subscribeSchema,
  unsubscribeSchema,
  type SubscribeInput,
  type UnsubscribeInput,
} from './push.service';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me/push-subscriptions')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('public-key')
  @ApiOperation({
    summary: 'Key the browser subscribes with (Web Push). publicKey = null: push is off',
  })
  publicKey(): { publicKey: string | null } {
    return this.push.publicKey();
  }

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Turn on push on this device: the PushSubscription from the browser',
  })
  @ApiZodBody(subscribeSchema)
  async subscribe(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(subscribeSchema)) body: SubscribeInput,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    await this.push.subscribe(auth.userId, body, userAgent);
  }

  @Post('remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Turn off push on this device' })
  @ApiZodBody(unsubscribeSchema)
  async unsubscribe(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(unsubscribeSchema)) body: UnsubscribeInput,
  ): Promise<void> {
    await this.push.unsubscribe(auth.userId, body);
  }
}
