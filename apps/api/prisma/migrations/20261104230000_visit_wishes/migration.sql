-- Task 80: the client's wishes for a visit (mood, drink, a note for the specialist), asked on the
-- last booking step when the salon switched each question on; the last ones are kept on the client.

-- CreateEnum
CREATE TYPE "visit_mood" AS ENUM ('chat', 'quiet', 'relax');

-- CreateEnum
CREATE TYPE "visit_drink" AS ENUM ('coffee', 'tea', 'water', 'none');

-- AlterTable
ALTER TABLE "appointment" ADD COLUMN     "wish_drink" "visit_drink",
ADD COLUMN     "wish_mood" "visit_mood",
ADD COLUMN     "wish_note" TEXT;

-- AlterTable
ALTER TABLE "customer" ADD COLUMN     "wish_drink" "visit_drink",
ADD COLUMN     "wish_mood" "visit_mood",
ADD COLUMN     "wish_note" TEXT;

-- AlterTable
ALTER TABLE "location" ADD COLUMN     "ask_drink" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ask_mood" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ask_note" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "drinks" "visit_drink"[] DEFAULT ARRAY[]::"visit_drink"[];

-- Prisma does not model CHECK constraints.
ALTER TABLE "appointment"
  ADD CONSTRAINT "appointment_wish_note_length_check" CHECK (char_length("wish_note") <= 200);
ALTER TABLE "customer"
  ADD CONSTRAINT "customer_wish_note_length_check" CHECK (char_length("wish_note") <= 200);
ALTER TABLE "location"
  ADD CONSTRAINT "location_drinks_check" CHECK (NOT ('none' = ANY ("drinks")));
