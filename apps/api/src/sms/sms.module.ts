import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DisabledSmsService, LogSmsService, MemorySmsService, SmsService } from './sms.service';

@Global()
@Module({
  providers: [
    {
      provide: SmsService,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): SmsService => {
        switch (config.SMS_TRANSPORT) {
          case 'memory':
            return new MemorySmsService();
          case 'log':
            return new LogSmsService();
          default:
            return new DisabledSmsService();
        }
      },
    },
  ],
  exports: [SmsService],
})
export class SmsModule {}
