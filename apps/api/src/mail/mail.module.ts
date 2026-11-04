import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { MailService, MemoryMailService, ResendMailService, SmtpMailService } from './mail.service';

@Global()
@Module({
  providers: [
    {
      provide: MailService,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): MailService => {
        switch (config.MAIL_TRANSPORT) {
          case 'memory': {
            const memory = new MemoryMailService();
            memory.mailFrom = config.MAIL_FROM;
            return memory;
          }
          case 'resend':
            return new ResendMailService(
              config.RESEND_API_URL,
              config.RESEND_API_KEY ?? '',
              config.MAIL_FROM,
            );
          default:
            return new SmtpMailService(config.SMTP_URL, config.MAIL_FROM);
        }
      },
    },
  ],
  exports: [MailService],
})
export class MailModule {}
