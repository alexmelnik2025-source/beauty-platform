-- Task 80b: example photos the client adds when booking ("Pokaż, co chcesz").

-- AlterTable
ALTER TABLE "service" ADD COLUMN     "wish_photos" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "visit_photo" (
    "id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visit_photo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visit_photo_appointment_id_idx" ON "visit_photo"("appointment_id");

-- CreateIndex
CREATE INDEX "visit_photo_location_id_idx" ON "visit_photo"("location_id");

-- AddForeignKey
ALTER TABLE "visit_photo" ADD CONSTRAINT "visit_photo_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_photo" ADD CONSTRAINT "visit_photo_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
