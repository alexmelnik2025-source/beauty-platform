-- Task Q4 (part 3): "Importuj z pliku" — a seller without Base sends its product file (Google
-- Merchant XML, Ceneo XML or CSV); the rows are kept for a day while it ticks what to import.

-- CreateEnum
CREATE TYPE "shop_feed_format" AS ENUM ('google', 'ceneo', 'csv');

-- CreateTable
CREATE TABLE "shop_feed_upload" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "format" "shop_feed_format" NOT NULL,
    "rows" JSONB NOT NULL,
    "unreadable" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_feed_upload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shop_feed_upload_location_id_created_at_idx" ON "shop_feed_upload"("location_id", "created_at");

-- AddForeignKey
ALTER TABLE "shop_feed_upload" ADD CONSTRAINT "shop_feed_upload_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
