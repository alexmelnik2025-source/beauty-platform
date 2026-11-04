-- Task 22: the salon chooses how many hours before the visit the reminder email goes (0 = none).

-- AlterTable
ALTER TABLE "location" ADD COLUMN     "reminder_hours_before" INTEGER NOT NULL DEFAULT 24;

-- Prisma does not model CHECK constraints.
ALTER TABLE "location"
  ADD CONSTRAINT "location_reminder_hours_before_check" CHECK ("reminder_hours_before" IN (0, 2, 3, 6, 12, 24, 48));
