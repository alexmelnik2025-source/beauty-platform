-- Task 70: a specialist's own duration of a service (null = the service's duration).
ALTER TABLE "staff_service" ADD COLUMN "duration_minutes" INTEGER;
ALTER TABLE "staff_service" ADD CONSTRAINT "staff_service_duration_range" CHECK ("duration_minutes" IS NULL OR ("duration_minutes" >= 5 AND "duration_minutes" <= 480));
