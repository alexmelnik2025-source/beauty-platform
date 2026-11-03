-- Loyalty rewards and coupons (task 10a, part 2): the salon's reward catalogue and the
-- coupons clients take for stamps or points. See docs/LOYALTY.md.

-- CreateEnum
CREATE TYPE "loyalty_reward_kind" AS ENUM ('discount_percent', 'free_service');

-- CreateEnum
CREATE TYPE "loyalty_coupon_status" AS ENUM ('active', 'used', 'cancelled');

-- CreateTable
CREATE TABLE "loyalty_reward" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "loyalty_reward_kind" NOT NULL,
    "discount_percent" INTEGER,
    "free_service_id" UUID,
    "cost" INTEGER NOT NULL,
    "service_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "coupon_validity_days" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loyalty_reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_coupon" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "reward_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "loyalty_coupon_status" NOT NULL DEFAULT 'active',
    "name" TEXT NOT NULL,
    "kind" "loyalty_reward_kind" NOT NULL,
    "discount_percent" INTEGER,
    "free_service_id" UUID,
    "service_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "cost" INTEGER NOT NULL,
    "redeem_transaction_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "used_appointment_id" UUID,
    "used_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loyalty_coupon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loyalty_reward_program_id_idx" ON "loyalty_reward"("program_id");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_coupon_code_key" ON "loyalty_coupon"("code");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_coupon_redeem_transaction_id_key" ON "loyalty_coupon"("redeem_transaction_id");

-- CreateIndex
CREATE INDEX "loyalty_coupon_account_id_status_idx" ON "loyalty_coupon"("account_id", "status");

-- CreateIndex
CREATE INDEX "loyalty_coupon_reward_id_idx" ON "loyalty_coupon"("reward_id");

-- AddForeignKey
ALTER TABLE "loyalty_reward" ADD CONSTRAINT "loyalty_reward_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "loyalty_program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_coupon" ADD CONSTRAINT "loyalty_coupon_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "loyalty_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_coupon" ADD CONSTRAINT "loyalty_coupon_reward_id_fkey" FOREIGN KEY ("reward_id") REFERENCES "loyalty_reward"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_coupon" ADD CONSTRAINT "loyalty_coupon_redeem_transaction_id_fkey" FOREIGN KEY ("redeem_transaction_id") REFERENCES "loyalty_transaction"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Not expressible in schema.prisma: a reward's kind and its fields must agree, costs are positive.
ALTER TABLE "loyalty_reward" ADD CONSTRAINT "loyalty_reward_kind_fields" CHECK (
  "cost" > 0 AND (
    ("kind" = 'discount_percent' AND "discount_percent" BETWEEN 1 AND 100 AND "free_service_id" IS NULL)
    OR ("kind" = 'free_service' AND "free_service_id" IS NOT NULL AND "discount_percent" IS NULL)
  )
);
