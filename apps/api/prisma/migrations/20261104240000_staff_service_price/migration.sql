-- Task 62: a specialist's own price of a service (null = the service's price).
ALTER TABLE "staff_service" ADD COLUMN "price_grosze" INTEGER;
ALTER TABLE "staff_service" ADD CONSTRAINT "staff_service_price_not_negative" CHECK ("price_grosze" IS NULL OR "price_grosze" >= 0);
