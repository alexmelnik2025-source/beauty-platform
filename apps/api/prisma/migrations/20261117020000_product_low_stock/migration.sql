-- Task 433: "Kończy się" — warn when a product has this many pieces or fewer (null = no warning).

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "low_stock_at" INTEGER;
