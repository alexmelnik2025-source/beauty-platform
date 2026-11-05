-- Task 165c: "time for your next visit" — the salon switches it on and sets the days and its own text.
ALTER TABLE "location" ADD COLUMN     "rebook_reminder_days" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rebook_reminder_text" TEXT;

ALTER TABLE "location"
  ADD CONSTRAINT "location_rebook_reminder_days_check" CHECK ("rebook_reminder_days" = 0 OR "rebook_reminder_days" BETWEEN 7 AND 365),
  ADD CONSTRAINT "location_rebook_reminder_text_length_check" CHECK (char_length("rebook_reminder_text") <= 500);
