import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PublicShopController } from './public-shop.controller';
import { ShopCatalogController } from './shop.controller';
import { ShopService } from './shop.service';

/** Task Q3: the platform's shop — the product catalogue and the salons' offers. */
@Module({
  imports: [OrganizationsModule],
  controllers: [ShopCatalogController, PublicShopController],
  providers: [ShopService],
  exports: [ShopService],
})
export class ShopModule {}
