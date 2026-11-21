-- Task 625: booking links (slugs) a salon used before stay reserved for it, so a link already
-- printed on QR codes and flyers cannot be taken by another salon after a rename.

-- CreateTable
CREATE TABLE "location_slug_history" (
    "slug" TEXT NOT NULL,
    "location_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_slug_history_pkey" PRIMARY KEY ("slug")
);

-- CreateIndex
CREATE INDEX "location_slug_history_location_id_idx" ON "location_slug_history"("location_id");

-- AddForeignKey
ALTER TABLE "location_slug_history" ADD CONSTRAINT "location_slug_history_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
