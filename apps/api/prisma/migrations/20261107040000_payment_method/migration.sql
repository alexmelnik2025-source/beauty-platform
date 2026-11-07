-- Task 227: how the client paid for a visit (only a mark the staff sets).

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('cash', 'card', 'blik', 'transfer', 'other');

-- AlterTable
ALTER TABLE "appointment" ADD COLUMN     "payment_method" "payment_method";
