-- Task Q3 (part 4): a product the client put aside to pick up and pay for at a visit.

-- CreateEnum
CREATE TYPE "product_reservation_status" AS ENUM ('reserved', 'handed', 'cancelled', 'expired');

-- AlterTable
ALTER TABLE "location" ADD COLUMN     "shop_reservation_days" INTEGER NOT NULL DEFAULT 14;

-- CreateTable
CREATE TABLE "product_reservation" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "product_id" UUID,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_grosze" INTEGER NOT NULL,
    "status" "product_reservation_status" NOT NULL DEFAULT 'reserved',
    "sale_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_reservation_sale_id_key" ON "product_reservation"("sale_id");

-- CreateIndex
CREATE INDEX "product_reservation_appointment_id_idx" ON "product_reservation"("appointment_id");

-- CreateIndex
CREATE INDEX "product_reservation_product_id_status_idx" ON "product_reservation"("product_id", "status");

-- CreateIndex
CREATE INDEX "product_reservation_location_id_idx" ON "product_reservation"("location_id");

-- AddForeignKey
ALTER TABLE "product_reservation" ADD CONSTRAINT "product_reservation_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reservation" ADD CONSTRAINT "product_reservation_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reservation" ADD CONSTRAINT "product_reservation_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reservation" ADD CONSTRAINT "product_reservation_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "product_sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
