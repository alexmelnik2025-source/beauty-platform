import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { BaseApi } from './integrations/base-api';
import { ShopIntegrationsController } from './integrations/integrations.controller';
import { ShopIntegrationsService } from './integrations/integrations.service';
import { SecretBox } from './integrations/secret-box';
import { ShopSyncScheduler } from './integrations/sync-scheduler';
import { PublicShopController } from './public-shop.controller';
import { ShopCatalogController } from './shop.controller';
import { ShopService } from './shop.service';

/** Task Q3: the platform's shop — the product catalogue and the salons' offers. */
@Module({
  imports: [OrganizationsModule],
  controllers: [ShopCatalogController, PublicShopController, ShopIntegrationsController],
  providers: [ShopService, ShopIntegrationsService, BaseApi, SecretBox, ShopSyncScheduler],
  exports: [ShopService],
})
export class ShopModule {}
