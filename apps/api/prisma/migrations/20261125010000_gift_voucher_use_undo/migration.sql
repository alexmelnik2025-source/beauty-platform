-- Task 530: "Cofnij płatność" — a payment with a gift voucher noted by mistake is undone (the amount goes back).

-- AlterTable
ALTER TABLE "gift_voucher_use" ADD COLUMN     "undone_at" TIMESTAMPTZ(3),
ADD COLUMN     "undone_by_user_id" UUID;
