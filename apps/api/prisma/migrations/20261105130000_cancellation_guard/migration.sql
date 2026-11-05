-- Task 161: "Ochrona przed odwołaniami" — the salon's rules for clients who often cancel or do not come.

-- CreateEnum
CREATE TYPE "cancellation_guard_action" AS ENUM ('approval', 'phone_only', 'prepay');

-- CreateTable
CREATE TABLE "cancellation_guard" (
    "location_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "max_changes" INTEGER,
    "window_hours" INTEGER NOT NULL DEFAULT 720,
    "late_cancel_minutes" INTEGER,
    "max_no_shows" INTEGER,
    "action" "cancellation_guard_action" NOT NULL DEFAULT 'approval',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cancellation_guard_pkey" PRIMARY KEY ("location_id")
);

-- CreateTable
CREATE TABLE "cancellation_guard_release" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "released_by_user_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cancellation_guard_release_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cancellation_guard_release_lookup_idx" ON "cancellation_guard_release"("location_id", "customer_id", "created_at");

-- CreateIndex
CREATE INDEX "cancellation_guard_release_customer_id_idx" ON "cancellation_guard_release"("customer_id");

-- AddForeignKey
ALTER TABLE "cancellation_guard" ADD CONSTRAINT "cancellation_guard_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_guard_release" ADD CONSTRAINT "cancellation_guard_release_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_guard_release" ADD CONSTRAINT "cancellation_guard_release_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
