-- Audit EJ fix (28.11.2026): "Odłóż na następną wizytę" kept on the server while the client has
-- no next visit yet; moved to that visit when it is booked.

-- CreateTable
CREATE TABLE "next_visit_product" (
    "id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "next_visit_product_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "next_visit_product_product_id_idx" ON "next_visit_product"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "next_visit_product_appointment_id_product_id_key" ON "next_visit_product"("appointment_id", "product_id");

-- AddForeignKey
ALTER TABLE "next_visit_product" ADD CONSTRAINT "next_visit_product_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "next_visit_product" ADD CONSTRAINT "next_visit_product_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
