-- Task Q2: where an online booking came from (QR code of the salon or of a specialist, the button
-- on the salon's site, the client app, the catalogue, a utm_source, the booking page itself).

-- AlterTable
ALTER TABLE "appointment" ADD COLUMN     "channel" VARCHAR(40),
ADD COLUMN     "channel_staff_id" UUID;
