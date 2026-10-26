import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { DisabledPushSender, MemoryPushSender, PushSender, WebPushSender } from './push.sender';

@Module({
  controllers: [PushController],
  providers: [
    PushService,
    {
      provide: PushSender,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): PushSender => {
        if (config.PUSH_TRANSPORT === 'memory') return new MemoryPushSender();
        if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
          return new WebPushSender(
            config.VAPID_PUBLIC_KEY,
            config.VAPID_PRIVATE_KEY,
            config.VAPID_SUBJECT,
          );
        }
        return new DisabledPushSender();
      },
    },
  ],
  exports: [PushService],
})
export class PushModule {}
