-- Languages a location and a staff member speak with clients (booking page badges, later the map filter).

-- CreateEnum
CREATE TYPE "language" AS ENUM ('pl', 'uk', 'ru', 'be', 'en');

-- AlterTable
ALTER TABLE "location" ADD COLUMN     "languages" "language"[] DEFAULT ARRAY[]::"language"[];

-- AlterTable
ALTER TABLE "staff_member" ADD COLUMN     "languages" "language"[] DEFAULT ARRAY[]::"language"[];
