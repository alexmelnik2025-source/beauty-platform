-- Task 164: a freed time is offered to the first client in the waiting list and held for 15 minutes.

-- AlterEnum
ALTER TYPE "waitlist_status" ADD VALUE 'offered';
ALTER TYPE "waitlist_status" ADD VALUE 'booked';
ALTER TYPE "waitlist_status" ADD VALUE 'declined';
ALTER TYPE "waitlist_status" ADD VALUE 'missed';

-- AlterTable
ALTER TABLE "waitlist_entry" ADD COLUMN     "offer_appointment_id" UUID,
ADD COLUMN     "offer_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "offer_token_hash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_entry_offer_token_hash_key" ON "waitlist_entry"("offer_token_hash");
