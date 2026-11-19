-- Task 448: "Cena zakupu" — the purchase price of a product, kept on every sale for the margin.

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "purchase_price_grosze" INTEGER;

-- AlterTable
ALTER TABLE "product_sale" ADD COLUMN     "unit_cost_grosze" INTEGER;
