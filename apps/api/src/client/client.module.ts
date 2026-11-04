import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { ClientGuard } from './client-auth';
import { ClientController } from './client.controller';
import { ClientLoyaltyService } from './client-loyalty.service';
import { ClientService } from './client.service';

/** "My visits" — the client app across salons. */
@Module({
  imports: [BookingModule, LoyaltyModule],
  controllers: [ClientController],
  providers: [ClientService, ClientLoyaltyService, ClientGuard],
})
export class ClientModule {}
