-- Task 229: the tip the client left (only a note the staff sets; not part of the revenue).

-- AlterTable
ALTER TABLE "appointment" ADD COLUMN     "tip_grosze" INTEGER NOT NULL DEFAULT 0;
