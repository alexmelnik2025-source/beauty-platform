import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { BookingModule } from './booking/booking.module';
import { ClientModule } from './client/client.module';
import { CommonModule } from './common/common.module';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { MailModule } from './mail/mail.module';
import { SmsModule } from './sms/sms.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { PrismaModule } from './prisma/prisma.module';
import { PushModule } from './push/push.module';
import { ReportsModule } from './reports/reports.module';
import { SchedulingModule } from './scheduling/scheduling.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    CommonModule,
    MailModule,
    SmsModule,
    AuthModule,
    OrganizationsModule,
    SchedulingModule,
    BookingModule,
    LoyaltyModule,
    ReportsModule,
    ClientModule,
    PushModule,
    HealthModule,
    AdminModule,
  ],
})
export class AppModule {}
