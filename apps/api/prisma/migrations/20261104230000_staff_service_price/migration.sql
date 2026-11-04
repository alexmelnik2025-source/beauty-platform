-- Task 70: a specialist may have their own price and duration of a service
-- (null = the service's own price and duration).

-- AlterTable
ALTER TABLE "staff_service" ADD COLUMN     "duration_minutes" INTEGER,
ADD COLUMN     "price_grosze" INTEGER;
