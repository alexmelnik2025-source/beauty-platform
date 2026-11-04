-- Task 21 (GDPR): when the owner erased the client's personal data.
ALTER TABLE "customer" ADD COLUMN "anonymized_at" TIMESTAMPTZ(3);
