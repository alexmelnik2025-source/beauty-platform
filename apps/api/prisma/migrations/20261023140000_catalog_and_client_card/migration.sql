-- Service categories and colours, client note and tags, "staff chosen by client" (stage 1).

-- CreateTable
CREATE TABLE "service_category" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_category_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "service" ADD COLUMN "category_id" UUID,
ADD COLUMN "color" TEXT;

-- AlterTable
ALTER TABLE "customer" ADD COLUMN "note" TEXT,
ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "appointment" ADD COLUMN "staff_chosen_by_client" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "service_category_location_id_name_key" ON "service_category"("location_id", "name");

-- CreateIndex
CREATE INDEX "service_category_id_idx" ON "service"("category_id");

-- AddForeignKey
ALTER TABLE "service_category" ADD CONSTRAINT "service_category_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Added by hand (Prisma does not express CHECK constraints).
ALTER TABLE "service" ADD CONSTRAINT "service_color_check" CHECK ("color" IS NULL OR "color" ~ '^#[0-9A-Fa-f]{6}$');
ALTER TABLE "customer" ADD CONSTRAINT "customer_tags_check" CHECK (cardinality("tags") <= 10);
