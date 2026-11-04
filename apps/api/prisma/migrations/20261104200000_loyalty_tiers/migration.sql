-- Task 10e: the salon's client tiers (Standard / Silver / Gold / VIP — names are the salon's),
-- reached by paid visits or by spend over a period, each with its own discount.

-- CreateEnum
CREATE TYPE "loyalty_tier_basis" AS ENUM ('visits', 'spend');

-- AlterTable
ALTER TABLE "loyalty_program" ADD COLUMN     "tier_basis" "loyalty_tier_basis" NOT NULL DEFAULT 'visits',
ADD COLUMN     "tier_period_days" INTEGER NOT NULL DEFAULT 365;

-- CreateTable
CREATE TABLE "loyalty_tier" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "discount_percent" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_tier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_tier_program_id_threshold_key" ON "loyalty_tier"("program_id", "threshold");

-- AddForeignKey
ALTER TABLE "loyalty_tier" ADD CONSTRAINT "loyalty_tier_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "loyalty_program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma does not model CHECK constraints.
ALTER TABLE "loyalty_tier"
  ADD CONSTRAINT "loyalty_tier_numbers_check" CHECK ("threshold" >= 0 AND "discount_percent" BETWEEN 0 AND 100);
ALTER TABLE "loyalty_program"
  ADD CONSTRAINT "loyalty_program_tier_period_check" CHECK ("tier_period_days" BETWEEN 1 AND 3650);
