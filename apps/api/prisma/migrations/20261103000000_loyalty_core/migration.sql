-- Loyalty program core (task 10a, part 1): the salon's program, per-service rules,
-- client balances and the append-only ledger; the "paid" mark on visits. See docs/LOYALTY.md.

-- CreateEnum
CREATE TYPE "loyalty_mode" AS ENUM ('stamps', 'points');

-- CreateEnum
CREATE TYPE "loyalty_transaction_type" AS ENUM ('earn', 'reverse', 'redeem', 'adjust', 'expire');

-- AlterTable
ALTER TABLE "appointment" ADD COLUMN     "paid_at" TIMESTAMPTZ(3),
ADD COLUMN     "paid_by_user_id" UUID;

-- CreateTable
CREATE TABLE "loyalty_program" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" "loyalty_mode" NOT NULL DEFAULT 'stamps',
    "stamps_per_visit" INTEGER NOT NULL DEFAULT 1,
    "points_per_unit" INTEGER NOT NULL DEFAULT 0,
    "spend_unit_grosze" INTEGER NOT NULL DEFAULT 10000,
    "min_spend_grosze" INTEGER NOT NULL DEFAULT 0,
    "points_validity_days" INTEGER,
    "max_discount_percent" INTEGER NOT NULL DEFAULT 100,
    "allow_stacking" BOOLEAN NOT NULL DEFAULT false,
    "marketplace_enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loyalty_program_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_earn_rule" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "points" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_earn_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_account" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "lifetime_earned" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loyalty_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_transaction" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "type" "loyalty_transaction_type" NOT NULL,
    "points" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "appointment_id" UUID,
    "reverses_id" UUID,
    "dedupe_key" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "actor_user_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_program_organization_id_key" ON "loyalty_program"("organization_id");

-- CreateIndex
CREATE INDEX "loyalty_earn_rule_service_id_idx" ON "loyalty_earn_rule"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_earn_rule_program_id_service_id_key" ON "loyalty_earn_rule"("program_id", "service_id");

-- CreateIndex
CREATE INDEX "loyalty_account_customer_id_idx" ON "loyalty_account"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_account_program_id_customer_id_key" ON "loyalty_account"("program_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_transaction_reverses_id_key" ON "loyalty_transaction"("reverses_id");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_transaction_dedupe_key_key" ON "loyalty_transaction"("dedupe_key");

-- CreateIndex
CREATE INDEX "loyalty_transaction_account_id_created_at_idx" ON "loyalty_transaction"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "loyalty_transaction_appointment_id_idx" ON "loyalty_transaction"("appointment_id");

-- AddForeignKey
ALTER TABLE "loyalty_program" ADD CONSTRAINT "loyalty_program_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_earn_rule" ADD CONSTRAINT "loyalty_earn_rule_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "loyalty_program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_earn_rule" ADD CONSTRAINT "loyalty_earn_rule_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_account" ADD CONSTRAINT "loyalty_account_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "loyalty_program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_account" ADD CONSTRAINT "loyalty_account_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transaction" ADD CONSTRAINT "loyalty_transaction_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "loyalty_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transaction" ADD CONSTRAINT "loyalty_transaction_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transaction" ADD CONSTRAINT "loyalty_transaction_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "loyalty_transaction"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Not expressible in schema.prisma: the last line of defence for "no negative balance"
-- (the service also checks inside a transaction with the account row locked).
ALTER TABLE "loyalty_account" ADD CONSTRAINT "loyalty_account_balance_not_negative" CHECK ("balance" >= 0);

-- The ledger is append-only: what an entry says may not be changed. Only the link to a
-- deleted visit may become empty (ON DELETE SET NULL); deleting a whole salon still cascades.
CREATE FUNCTION "loyalty_transaction_no_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.points IS DISTINCT FROM OLD.points
    OR NEW.balance_after IS DISTINCT FROM OLD.balance_after
    OR NEW.reverses_id IS DISTINCT FROM OLD.reverses_id
    OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
    OR NEW.note IS DISTINCT FROM OLD.note
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (NEW.appointment_id IS NOT NULL AND NEW.appointment_id IS DISTINCT FROM OLD.appointment_id)
  THEN
    RAISE EXCEPTION 'loyalty_transaction rows are append-only';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "loyalty_transaction_append_only" BEFORE UPDATE ON "loyalty_transaction"
  FOR EACH ROW EXECUTE FUNCTION "loyalty_transaction_no_update"();
