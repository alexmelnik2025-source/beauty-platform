-- Time blocks in the calendar (stage 1).

-- CreateTable
CREATE TABLE "time_block" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "staff_id" UUID,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "created_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "time_block_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "time_block_location_id_start_at_idx" ON "time_block"("location_id", "start_at");

-- CreateIndex
CREATE INDEX "time_block_staff_id_start_at_idx" ON "time_block"("staff_id", "start_at");

-- CreateIndex
CREATE INDEX "time_block_location_id_updated_at_idx" ON "time_block"("location_id", "updated_at");

-- AddForeignKey
ALTER TABLE "time_block" ADD CONSTRAINT "time_block_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_block" ADD CONSTRAINT "time_block_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Added by hand (Prisma does not express CHECK constraints).
ALTER TABLE "time_block" ADD CONSTRAINT "time_block_range_check" CHECK ("start_at" < "end_at");
