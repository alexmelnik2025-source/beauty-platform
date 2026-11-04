-- Task 19: extra stamps or points at chosen specialists and/or on chosen weekdays.

-- CreateTable
CREATE TABLE "loyalty_bonus_rule" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "staff_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "multiplier" INTEGER NOT NULL DEFAULT 1,
    "extra_points" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_bonus_rule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loyalty_bonus_rule_program_id_idx" ON "loyalty_bonus_rule"("program_id");

-- AddForeignKey
ALTER TABLE "loyalty_bonus_rule" ADD CONSTRAINT "loyalty_bonus_rule_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "loyalty_program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma does not model CHECK constraints. A rule always gives something extra.
ALTER TABLE "loyalty_bonus_rule"
  ADD CONSTRAINT "loyalty_bonus_rule_numbers_check"
  CHECK ("multiplier" BETWEEN 1 AND 10 AND "extra_points" BETWEEN 0 AND 100000
         AND ("multiplier" > 1 OR "extra_points" > 0)
         AND "weekdays" <@ ARRAY[1,2,3,4,5,6,7]);
