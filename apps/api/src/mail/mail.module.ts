import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { MailService, MemoryMailService, SmtpMailService } from './mail.service';

@Global()
@Module({
  providers: [
    {
      provide: MailService,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): MailService =>
        config.MAIL_TRANSPORT === 'memory'
          ? new MemoryMailService()
          : new SmtpMailService(config.SMTP_URL, config.MAIL_FROM),
    },
  ],
  exports: [MailService],
})
export class MailModule {}
