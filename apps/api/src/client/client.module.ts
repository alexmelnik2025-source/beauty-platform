import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { ClientGuard } from './client-auth';
import { ClientController } from './client.controller';
import { ClientService } from './client.service';

/** "My visits" — the client app across salons. */
@Module({
  imports: [BookingModule],
  controllers: [ClientController],
  providers: [ClientService, ClientGuard],
})
export class ClientModule {}
