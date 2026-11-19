-- Task 443: "Odpis" — pieces used in the salon, damaged or lost, with a note.

-- AlterEnum
ALTER TYPE "stock_movement_kind" ADD VALUE 'write_off';

-- AlterTable
ALTER TABLE "stock_movement" ADD COLUMN     "note" TEXT;
