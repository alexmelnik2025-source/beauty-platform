-- Task 51: waiting list - a client is emailed when a time frees up on a chosen day.

-- CreateTable
CREATE TABLE "waitlist_entry" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "staff_id" UUID,
    "date" DATE NOT NULL,
    "email" TEXT NOT NULL,
    "locale" "locale" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_at" TIMESTAMPTZ(3),
    "notice_id" UUID,

    CONSTRAINT "waitlist_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "waitlist_entry_location_id_date_idx" ON "waitlist_entry"("location_id", "date");

-- CreateIndex
CREATE INDEX "waitlist_entry_person_id_idx" ON "waitlist_entry"("person_id");

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
