-- Launch task L5: every location prices its services in its own currency (ISO 4217).
-- Amounts stay in hundredths of that currency; existing salons keep PLN.

-- AlterTable
ALTER TABLE "location" ADD COLUMN     "currency" CHAR(3) NOT NULL DEFAULT 'PLN';
