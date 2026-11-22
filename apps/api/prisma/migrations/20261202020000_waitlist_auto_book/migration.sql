-- Task Q8: the waiting list books the first free time automatically for clients who ask for it.
ALTER TABLE "waitlist_entry" ADD COLUMN     "auto_book" BOOLEAN NOT NULL DEFAULT false;
