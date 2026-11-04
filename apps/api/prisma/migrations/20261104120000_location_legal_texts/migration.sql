-- Launch task L1: the salon's own booking terms (regulamin) and privacy policy, in Markdown.
-- Online booking can be switched on only when both are written.

-- AlterTable
ALTER TABLE "location" ADD COLUMN     "booking_terms" TEXT,
ADD COLUMN     "privacy_policy" TEXT;
