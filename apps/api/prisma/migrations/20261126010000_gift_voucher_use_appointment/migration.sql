-- Task 540: "Zapłać bonem" in the visit card — a payment with a gift voucher remembers the visit it paid for.

-- AlterTable
ALTER TABLE "gift_voucher_use" ADD COLUMN     "appointment_id" UUID;

-- CreateIndex
CREATE INDEX "gift_voucher_use_appointment_id_idx" ON "gift_voucher_use"("appointment_id");

-- AddForeignKey
ALTER TABLE "gift_voucher_use" ADD CONSTRAINT "gift_voucher_use_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
