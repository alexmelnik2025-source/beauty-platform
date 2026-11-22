-- Task Q9: "Zasady dla klienta" — the salon's own cancellation-guard rule for one client,
-- and the amount a client was told to pay in the salon when booking online.
CREATE TYPE "customer_guard_rule" AS ENUM ('salon', 'trusted', 'prepay', 'approval', 'phone_only');

ALTER TABLE "customer" ADD COLUMN "guard_rule" "customer_guard_rule" NOT NULL DEFAULT 'salon';

ALTER TABLE "appointment" ADD COLUMN "owed_grosze" INTEGER;
