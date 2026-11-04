-- Launch task L4: block the same time every week (while bookings move over from Booksy).
-- Blocks made together share series_id.

-- AlterTable
ALTER TABLE "time_block" ADD COLUMN     "series_id" UUID;

-- CreateIndex
CREATE INDEX "time_block_series_id_idx" ON "time_block"("series_id");
