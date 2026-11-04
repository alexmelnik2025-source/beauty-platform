-- Task 10e, part 3: the client's tier discount used on a visit. It is part of the visit's
-- discount (the client pays price - discount), kept apart so it can be taken off again,
-- with the tier's name and percentage as they were when it was used.

-- AlterTable
ALTER TABLE "appointment" ADD COLUMN     "tier_discount_grosze" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tier_discount_percent" INTEGER,
ADD COLUMN     "tier_name" TEXT;

-- The tier discount is within the visit's whole discount, and a used one names its tier.
ALTER TABLE "appointment"
  ADD CONSTRAINT "appointment_tier_discount_check" CHECK (
    "tier_discount_grosze" >= 0
    AND "tier_discount_grosze" <= "discount_grosze"
    AND ("tier_discount_grosze" = 0) = ("tier_name" IS NULL)
    AND ("tier_name" IS NULL) = ("tier_discount_percent" IS NULL)
  );
