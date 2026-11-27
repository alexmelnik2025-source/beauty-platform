CREATE TABLE "visit_used_product" (
  "appointment_id" UUID NOT NULL REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "product_id" UUID NOT NULL REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY ("appointment_id", "product_id")
);
CREATE INDEX "visit_used_product_product_id_idx" ON "visit_used_product"("product_id");
ALTER TABLE "product_reservation" ADD COLUMN "after_visit_pickup" BOOLEAN NOT NULL DEFAULT false;
