-- Task 490: "Bony podarunkowe" — gift vouchers sold at the salon's till and the payments made with them.

-- CreateTable
CREATE TABLE "gift_voucher" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "amount_grosze" INTEGER NOT NULL,
    "balance_grosze" INTEGER NOT NULL,
    "valid_until" DATE,
    "recipient" TEXT,
    "note" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(3),

    CONSTRAINT "gift_voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_voucher_use" (
    "id" UUID NOT NULL,
    "voucher_id" UUID NOT NULL,
    "amount_grosze" INTEGER NOT NULL,
    "note" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_voucher_use_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gift_voucher_location_id_created_at_idx" ON "gift_voucher"("location_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "gift_voucher_location_id_code_key" ON "gift_voucher"("location_id", "code");

-- CreateIndex
CREATE INDEX "gift_voucher_use_voucher_id_created_at_idx" ON "gift_voucher_use"("voucher_id", "created_at");

-- AddForeignKey
ALTER TABLE "gift_voucher" ADD CONSTRAINT "gift_voucher_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_voucher_use" ADD CONSTRAINT "gift_voucher_use_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "gift_voucher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
