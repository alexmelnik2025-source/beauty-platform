-- Task 236: "Wpłata / wypłata" — cash put into or taken out of the till during a salon day.

-- CreateEnum
CREATE TYPE "till_movement_kind" AS ENUM ('in', 'out');

-- CreateTable
CREATE TABLE "till_movement" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "kind" "till_movement_kind" NOT NULL,
    "amount_grosze" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "created_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "till_movement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "till_movement_location_id_date_idx" ON "till_movement"("location_id", "date");

-- AddForeignKey
ALTER TABLE "till_movement" ADD CONSTRAINT "till_movement_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
