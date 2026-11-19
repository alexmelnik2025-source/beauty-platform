-- Task 520: "Kod kreskowy" — the code on the product's package; one product per code in a salon.

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "barcode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "product_location_id_barcode_key" ON "product"("location_id", "barcode");
