-- Business app (task 11a, part 2): the owner adds a phone number to an invitation, and the
-- invited person (or an account with a phone) signs in by that number. Without an SMS gateway
-- the code goes to the account's or invitation's email.

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "invitation" ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "staff_login_code" ADD COLUMN     "by_sms" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "phone" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "app_user_phone_key" ON "app_user"("phone");

-- CreateIndex
CREATE INDEX "invitation_phone_idx" ON "invitation"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "staff_login_code_phone_key" ON "staff_login_code"("phone");
