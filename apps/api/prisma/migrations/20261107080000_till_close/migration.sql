-- Task 232: "Zamknij kasę" — the cash counted in the till at the end of a salon day.

-- CreateTable
CREATE TABLE "till_close" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "counted_cash_grosze" INTEGER NOT NULL,
    "expected_cash_grosze" INTEGER NOT NULL,
    "note" TEXT,
    "closed_by_user_id" UUID,
    "closed_by_name" TEXT NOT NULL,
    "closed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "till_close_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "till_close_location_id_date_key" ON "till_close"("location_id", "date");

-- AddForeignKey
ALTER TABLE "till_close" ADD CONSTRAINT "till_close_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
