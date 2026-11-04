-- Task 50: "tell me when a time becomes free" — the waiting list of a salon.

-- CreateEnum
CREATE TYPE "waitlist_status" AS ENUM ('waiting', 'notified', 'cancelled');

-- CreateTable
CREATE TABLE "waitlist_entry" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "staff_id" UUID,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "locale" "locale" NOT NULL DEFAULT 'pl',
    "status" "waitlist_status" NOT NULL DEFAULT 'waiting',
    "token_hash" TEXT NOT NULL,
    "notified_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_entry_token_hash_key" ON "waitlist_entry"("token_hash");

-- CreateIndex
CREATE INDEX "waitlist_entry_status_date_idx" ON "waitlist_entry"("status", "date");

-- CreateIndex
CREATE INDEX "waitlist_entry_location_id_date_idx" ON "waitlist_entry"("location_id", "date");

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
