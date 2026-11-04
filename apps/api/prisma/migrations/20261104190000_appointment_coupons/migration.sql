-- Task 10d: a client's loyalty coupon applied to a visit lowers its price.
-- The visit keeps its price snapshot and the discount next to it; the coupon remembers
-- the visit and what it took off.

-- AlterTable
ALTER TABLE "appointment" ADD COLUMN     "discount_grosze" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "loyalty_coupon" ADD COLUMN     "discount_grosze" INTEGER;

-- CreateIndex
CREATE INDEX "loyalty_coupon_used_appointment_id_idx" ON "loyalty_coupon"("used_appointment_id");

-- A discount never makes a visit cost less than nothing (Prisma does not model CHECK constraints).
ALTER TABLE "appointment"
  ADD CONSTRAINT "appointment_discount_check" CHECK ("discount_grosze" >= 0 AND "discount_grosze" <= "price_grosze");

-- A used coupon always says which visit and how much; an unused one says neither.
ALTER TABLE "loyalty_coupon"
  ADD CONSTRAINT "loyalty_coupon_used_check" CHECK (
    ("status" = 'used') = ("used_appointment_id" IS NOT NULL)
    AND ("used_appointment_id" IS NULL) = ("discount_grosze" IS NULL)
    AND ("discount_grosze" IS NULL OR "discount_grosze" >= 0)
  );
