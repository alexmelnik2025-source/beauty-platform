-- Task 165b: reviews after the visit — the salon switches them on; one rating per visit that took place.

-- CreateTable
CREATE TABLE "review_settings" (
    "location_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "request_hours" INTEGER NOT NULL DEFAULT 2,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "review_settings_pkey" PRIMARY KEY ("location_id")
);

-- CreateTable
CREATE TABLE "visit_review" (
    "id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "text" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "visit_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "visit_review_appointment_id_key" ON "visit_review"("appointment_id");

-- CreateIndex
CREATE INDEX "visit_review_location_id_created_at_idx" ON "visit_review"("location_id", "created_at");

-- CreateIndex
CREATE INDEX "visit_review_staff_id_idx" ON "visit_review"("staff_id");

-- AddForeignKey
ALTER TABLE "review_settings" ADD CONSTRAINT "review_settings_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_review" ADD CONSTRAINT "visit_review_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_review" ADD CONSTRAINT "visit_review_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_review" ADD CONSTRAINT "visit_review_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Checks (not part of the Prisma schema)
ALTER TABLE "review_settings"
  ADD CONSTRAINT "review_settings_request_hours_check" CHECK ("request_hours" BETWEEN 1 AND 72);
ALTER TABLE "visit_review"
  ADD CONSTRAINT "visit_review_rating_check" CHECK ("rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "visit_review_text_length_check" CHECK (char_length("text") <= 1000);
