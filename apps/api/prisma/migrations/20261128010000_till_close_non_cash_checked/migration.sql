-- Task 554: "Sprawdzono z terminalem i kontem" — the payments not in cash of the day were checked at the close.

-- AlterTable
ALTER TABLE "till_close" ADD COLUMN     "non_cash_checked" BOOLEAN NOT NULL DEFAULT false;
