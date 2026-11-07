-- Task 240: the client's birthday — day and month only ("MM-DD"), no year.

-- AlterTable
ALTER TABLE "customer" ADD COLUMN     "birthday" CHAR(5);
