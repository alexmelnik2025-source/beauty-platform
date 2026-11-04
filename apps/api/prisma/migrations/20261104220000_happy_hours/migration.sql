-- Task 16: the salon's happy hours — a lower price on chosen weekdays and hours, for all or some
-- staff members and services. A visit remembers the price before it and the percentage.

-- AlterTable
ALTER TABLE "appointment" ADD COLUMN     "happy_hour_percent" INTEGER,
ADD COLUMN     "list_price_grosze" INTEGER;

-- CreateTable
CREATE TABLE "happy_hour" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "weekdays" INTEGER[],
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "discount_percent" INTEGER NOT NULL,
    "staff_ids" UUID[],
    "service_ids" UUID[],
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "happy_hour_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "happy_hour_location_id_idx" ON "happy_hour"("location_id");

-- AddForeignKey
ALTER TABLE "happy_hour" ADD CONSTRAINT "happy_hour_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma does not model CHECK constraints.
ALTER TABLE "happy_hour"
  ADD CONSTRAINT "happy_hour_numbers_check" CHECK (
    "start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute"
    AND "discount_percent" BETWEEN 1 AND 90
  );
-- A visit's happy-hour price is below the price before it, and both are set together.
ALTER TABLE "appointment"
  ADD CONSTRAINT "appointment_happy_hour_check" CHECK (
    ("list_price_grosze" IS NULL) = ("happy_hour_percent" IS NULL)
    AND ("list_price_grosze" IS NULL OR "list_price_grosze" >= "price_grosze")
  );
