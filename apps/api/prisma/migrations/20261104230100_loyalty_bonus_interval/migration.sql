-- Task 19c: a bonus rule only for clients who come back within N days of their previous paid visit.

-- AlterTable
ALTER TABLE "loyalty_bonus_rule" ADD COLUMN     "within_days" INTEGER;

-- Prisma does not model CHECK constraints.
ALTER TABLE "loyalty_bonus_rule"
  ADD CONSTRAINT "loyalty_bonus_rule_within_days_check" CHECK ("within_days" BETWEEN 1 AND 365);
