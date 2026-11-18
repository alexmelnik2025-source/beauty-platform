-- Task 440: "Historia magazynu" — every change of a product's pieces in stock, who and when.

-- CreateEnum
CREATE TYPE "stock_movement_kind" AS ENUM ('sale', 'sale_removed', 'delivery', 'correction');

-- CreateTable
CREATE TABLE "stock_movement" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "kind" "stock_movement_kind" NOT NULL,
    "change" INTEGER NOT NULL,
    "quantity_after" INTEGER,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_movement_product_id_created_at_idx" ON "stock_movement"("product_id", "created_at");

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
