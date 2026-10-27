-- Salon and staff photos for the booking page, stored in the database (task 6, part 2).

-- CreateTable
CREATE TABLE "photo" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "staff_id" UUID,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "photo_staff_id_key" ON "photo"("staff_id");

-- CreateIndex
CREATE INDEX "photo_location_id_idx" ON "photo"("location_id");

-- AddForeignKey
ALTER TABLE "photo" ADD CONSTRAINT "photo_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo" ADD CONSTRAINT "photo_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
