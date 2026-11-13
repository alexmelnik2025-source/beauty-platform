-- Task 394: "Produkty" — the salon's products and the ones sold at a visit.

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_grosze" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_sale" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "product_id" UUID,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_grosze" INTEGER NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_sale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_location_id_idx" ON "product"("location_id");

-- CreateIndex
CREATE INDEX "product_sale_appointment_id_idx" ON "product_sale"("appointment_id");

-- CreateIndex
CREATE INDEX "product_sale_location_id_idx" ON "product_sale"("location_id");

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_sale" ADD CONSTRAINT "product_sale_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_sale" ADD CONSTRAINT "product_sale_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_sale" ADD CONSTRAINT "product_sale_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
