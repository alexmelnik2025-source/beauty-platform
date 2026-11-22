-- Task Q7: "Last Minute" promotions — a discount for online visits booked shortly before they start.
ALTER TABLE "happy_hour" ADD COLUMN     "last_minute_hours" INTEGER;

-- Prisma does not model CHECK constraints.
ALTER TABLE "happy_hour"
  ADD CONSTRAINT "happy_hour_last_minute_check" CHECK (
    "last_minute_hours" IS NULL OR "last_minute_hours" BETWEEN 1 AND 72
  );
