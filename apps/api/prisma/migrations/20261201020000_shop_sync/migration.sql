-- Task Q4 (part 2): prices and stock of the products imported from Base are renewed regularly
-- (and on "Synchronizuj teraz"); every import and renewal is written to the seller's log.

-- CreateEnum
CREATE TYPE "shop_sync_trigger" AS ENUM ('import', 'manual', 'schedule');

-- AlterTable
ALTER TABLE "shop_integration" ADD COLUMN     "last_sync_at" TIMESTAMPTZ(3),
ADD COLUMN     "sync_every_minutes" INTEGER NOT NULL DEFAULT 60;

-- CreateTable
CREATE TABLE "shop_sync_run" (
    "id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "trigger" "shop_sync_trigger" NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "checked" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "missing" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_message" TEXT,

    CONSTRAINT "shop_sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shop_sync_run_integration_id_started_at_idx" ON "shop_sync_run"("integration_id", "started_at");

-- AddForeignKey
ALTER TABLE "shop_sync_run" ADD CONSTRAINT "shop_sync_run_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "shop_integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
