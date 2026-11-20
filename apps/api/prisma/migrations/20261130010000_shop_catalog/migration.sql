-- Task Q3 (part 1): the platform's product catalogue ("Sklep") — one card per product, offered by
-- salons through their own products (price and stock of the salon). At the launch only pickup at
-- the salon is allowed.

-- CreateEnum
CREATE TYPE "shop_category" AS ENUM ('hair_care', 'styling', 'beard', 'skin_care', 'tools', 'accessories', 'gifts', 'other');

-- CreateEnum
CREATE TYPE "shop_fulfillment" AS ENUM ('pickup_at_salon', 'shipping');

-- AlterTable
ALTER TABLE "location" ADD COLUMN     "shop_fulfillment" "shop_fulfillment"[] DEFAULT ARRAY['pickup_at_salon']::"shop_fulfillment"[];

-- CreateTable
CREATE TABLE "catalog_product" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "ean" TEXT,
    "description" TEXT,
    "category" "shop_category" NOT NULL DEFAULT 'other',
    "created_by_location_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalog_product_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalog_product_ean_key" ON "catalog_product"("ean");

-- CreateIndex
CREATE INDEX "catalog_product_name_idx" ON "catalog_product"("name");

-- AddForeignKey
ALTER TABLE "catalog_product" ADD CONSTRAINT "catalog_product_created_by_location_id_fkey" FOREIGN KEY ("created_by_location_id") REFERENCES "location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "photo" ADD COLUMN     "catalog_product_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "photo_catalog_product_id_key" ON "photo"("catalog_product_id");

-- AddForeignKey
ALTER TABLE "photo" ADD CONSTRAINT "photo_catalog_product_id_fkey" FOREIGN KEY ("catalog_product_id") REFERENCES "catalog_product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "catalog_product_id" UUID,
ADD COLUMN     "in_salon_shop" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "in_marketplace" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "product_catalog_product_id_idx" ON "product"("catalog_product_id");

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_catalog_product_id_fkey" FOREIGN KEY ("catalog_product_id") REFERENCES "catalog_product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
