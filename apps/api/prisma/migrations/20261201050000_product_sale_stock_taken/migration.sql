-- Task 622: whether a sale at a visit took pieces from stock. Removing the sale puts pieces
-- back only then (a product that started being counted after the sale got phantom pieces).
-- Sales made before this change keep the old behaviour (true); new ones say it themselves.

-- AlterTable
ALTER TABLE "product_sale" ADD COLUMN "stock_taken" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "product_sale" ALTER COLUMN "stock_taken" SET DEFAULT false;
