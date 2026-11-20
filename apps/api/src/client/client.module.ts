import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { ShopModule } from '../shop/shop.module';
import { WaitlistModule } from '../waitlist/waitlist.module';
import { ClientGuard } from './client-auth';
import { ClientCalendarController } from './client-calendar.controller';
import { ClientFavoritesController } from './client-favorites.controller';
import { ClientFavoritesService } from './client-favorites.service';
import { ClientReviewsController } from './client-reviews.controller';
import { ClientShopController } from './client-shop.controller';
import { ClientWaitlistController } from './client-waitlist.controller';
import { ClientController } from './client.controller';
import { ClientExportService } from './client-export.service';
import { ClientLoyaltyService } from './client-loyalty.service';
import { ClientService } from './client.service';

/** "My visits" — the client app across salons. */
@Module({
  imports: [BookingModule, LoyaltyModule, WaitlistModule, ReviewsModule, ShopModule],
  controllers: [
    ClientController,
    ClientCalendarController,
    ClientFavoritesController,
    ClientWaitlistController,
    ClientReviewsController,
    ClientShopController,
  ],
  providers: [
    ClientService,
    ClientLoyaltyService,
    ClientExportService,
    ClientFavoritesService,
    ClientGuard,
  ],
})
export class ClientModule {}
