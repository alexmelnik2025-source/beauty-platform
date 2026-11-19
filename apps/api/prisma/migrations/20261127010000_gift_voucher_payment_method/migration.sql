-- Task 547: how the client paid for a gift voucher (cash goes into the till of the day it was sold).

-- AlterTable
ALTER TABLE "gift_voucher" ADD COLUMN     "payment_method" "payment_method";
