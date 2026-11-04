-- Task 23: "Favourite salons" in the client app.

-- CreateTable
CREATE TABLE "client_favorite" (
    "person_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_favorite_pkey" PRIMARY KEY ("person_id","location_id")
);

-- CreateIndex
CREATE INDEX "client_favorite_location_id_idx" ON "client_favorite"("location_id");

-- AddForeignKey
ALTER TABLE "client_favorite" ADD CONSTRAINT "client_favorite_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_favorite" ADD CONSTRAINT "client_favorite_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
