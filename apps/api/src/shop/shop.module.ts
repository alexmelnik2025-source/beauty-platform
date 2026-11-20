import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { BaseApi } from './integrations/base-api';
import { ShopIntegrationsController } from './integrations/integrations.controller';
import { ShopIntegrationsService } from './integrations/integrations.service';
import { SecretBox } from './integrations/secret-box';
import { ShopSyncScheduler } from './integrations/sync-scheduler';
import { PublicShopController } from './public-shop.controller';
import { VisitReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { ShopCatalogController } from './shop.controller';
import { ShopService } from './shop.service';

/** Task Q3: the platform's shop — the product catalogue, the salons' offers, products put aside for a visit. */
@Module({
  imports: [OrganizationsModule, BookingModule],
  controllers: [
    ShopCatalogController,
    PublicShopController,
    ShopIntegrationsController,
    VisitReservationsController,
  ],
  providers: [
    ShopService,
    ShopIntegrationsService,
    BaseApi,
    SecretBox,
    ShopSyncScheduler,
    ReservationsService,
  ],
  exports: [ShopService, ReservationsService],
})
export class ShopModule {}
