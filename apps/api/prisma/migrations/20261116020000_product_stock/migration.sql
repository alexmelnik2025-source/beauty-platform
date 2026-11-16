-- Task 429: "Stan magazynowy" — pieces of a product in stock (null = not counted).

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "stock_quantity" INTEGER;
