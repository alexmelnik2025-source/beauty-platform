-- Task Q4 (part 1): "Mój sklep" → "Integracje" — a salon connects its own Base (BaseLinker) with
-- its API token (stored encrypted) and imports the products it chooses.

-- CreateEnum
CREATE TYPE "shop_integration_provider" AS ENUM ('base');

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "external_ref" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "product_location_id_external_ref_key" ON "product"("location_id", "external_ref");

-- CreateTable
CREATE TABLE "shop_integration" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "provider" "shop_integration_provider" NOT NULL,
    "token_ciphertext" TEXT NOT NULL,
    "token_hint" TEXT NOT NULL,
    "inventory_id" TEXT,
    "inventory_name" TEXT,
    "price_group_id" TEXT,
    "warehouse_id" TEXT,
    "last_import_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shop_integration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shop_integration_location_id_provider_key" ON "shop_integration"("location_id", "provider");

-- AddForeignKey
ALTER TABLE "shop_integration" ADD CONSTRAINT "shop_integration_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
