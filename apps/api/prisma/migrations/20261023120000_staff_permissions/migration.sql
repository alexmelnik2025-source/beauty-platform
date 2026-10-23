-- Staff categories and personal permission exceptions (stage 1).

-- CreateTable
CREATE TABLE "staff_category" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "staff_category_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "membership" ADD COLUMN "staff_category_id" UUID,
ADD COLUMN "permission_overrides" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "staff_category_organization_id_name_key" ON "staff_category"("organization_id", "name");

-- CreateIndex
CREATE INDEX "membership_staff_category_id_idx" ON "membership"("staff_category_id");

-- AddForeignKey
ALTER TABLE "staff_category" ADD CONSTRAINT "staff_category_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_staff_category_id_fkey" FOREIGN KEY ("staff_category_id") REFERENCES "staff_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Stored maps must be JSON objects (keys are checked by the API).
ALTER TABLE "staff_category" ADD CONSTRAINT "staff_category_permissions_object_check"
  CHECK (jsonb_typeof("permissions") = 'object');
ALTER TABLE "membership" ADD CONSTRAINT "membership_permission_overrides_object_check"
  CHECK (jsonb_typeof("permission_overrides") = 'object');
