-- Needed so a GiST index can compare UUIDs with "=" (the no-overlap rule below).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('held', 'confirmed', 'cancelled', 'expired', 'completed', 'no_show');

-- CreateEnum
CREATE TYPE "appointment_source" AS ENUM ('online', 'manual');

-- CreateEnum
CREATE TYPE "cancelled_by" AS ENUM ('customer', 'salon');

-- CreateEnum
CREATE TYPE "consent_type" AS ENUM ('booking_terms', 'marketing');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('pending', 'sent', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "locale" "locale" NOT NULL DEFAULT 'pl',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_record" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "type" "consent_type" NOT NULL,
    "version" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "customer_id" UUID,
    "status" "appointment_status" NOT NULL,
    "source" "appointment_source" NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "blocked_until" TIMESTAMPTZ(3) NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(3),
    "hold_token_hash" TEXT,
    "hold_contact" JSONB,
    "locale" "locale" NOT NULL DEFAULT 'pl',
    "price_grosze" INTEGER NOT NULL,

    "duration_minutes" INTEGER NOT NULL,
    "buffer_minutes" INTEGER NOT NULL,
    "note" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" "cancelled_by",
    "cancel_reason" TEXT,
    "created_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_event" (
    "id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actor_user_id" UUID,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_code" (
    "id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "send_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verification_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_access_token" (
    "id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_access_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,

    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_organization_id_name_idx" ON "customer"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "customer_organization_id_email_key" ON "customer"("organization_id", "email");

-- CreateIndex
CREATE INDEX "consent_record_customer_id_type_idx" ON "consent_record"("customer_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_hold_token_hash_key" ON "appointment"("hold_token_hash");

-- CreateIndex
CREATE INDEX "appointment_location_id_start_at_idx" ON "appointment"("location_id", "start_at");

-- CreateIndex
CREATE INDEX "appointment_staff_id_start_at_idx" ON "appointment"("staff_id", "start_at");

-- CreateIndex
CREATE INDEX "appointment_customer_id_idx" ON "appointment"("customer_id");

-- CreateIndex
CREATE INDEX "appointment_status_hold_expires_at_idx" ON "appointment"("status", "hold_expires_at");

-- CreateIndex
CREATE INDEX "appointment_event_appointment_id_created_at_idx" ON "appointment_event"("appointment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "verification_code_appointment_id_key" ON "verification_code"("appointment_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_access_token_token_hash_key" ON "appointment_access_token"("token_hash");

-- CreateIndex
CREATE INDEX "appointment_access_token_appointment_id_idx" ON "appointment_access_token"("appointment_id");


-- CreateIndex
CREATE UNIQUE INDEX "notification_outbox_dedupe_key_key" ON "notification_outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "notification_outbox_status_next_attempt_at_idx" ON "notification_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_scope_key_key" ON "idempotency_key"("scope", "key");

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_event" ADD CONSTRAINT "appointment_event_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_code" ADD CONSTRAINT "verification_code_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_access_token" ADD CONSTRAINT "appointment_access_token_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Rules Prisma cannot express (added by hand) ───────────────────────

-- The core guarantee: one staff member can never have two live bookings whose
-- blocked time overlaps. Held (unconfirmed) and confirmed rows both count.
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_no_overlap"
  EXCLUDE USING gist ("staff_id" WITH =, tstzrange("start_at", "blocked_until", '[)') WITH &&)
  WHERE ("status" IN ('held', 'confirmed'));

ALTER TABLE "appointment" ADD CONSTRAINT "appointment_times_check"
  CHECK ("start_at" < "end_at" AND "end_at" <= "blocked_until");

ALTER TABLE "appointment" ADD CONSTRAINT "appointment_hold_check"
  CHECK ("status" <> 'held' OR ("hold_expires_at" IS NOT NULL AND "hold_token_hash" IS NOT NULL));

ALTER TABLE "appointment" ADD CONSTRAINT "appointment_amounts_check"
  CHECK ("price_grosze" >= 0 AND "duration_minutes" > 0 AND "buffer_minutes" >= 0);

ALTER TABLE "verification_code" ADD CONSTRAINT "verification_code_counts_check"
  CHECK ("attempts" >= 0 AND "send_count" >= 1);
