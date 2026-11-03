-- Business app (task 11a, part 3): what a specialist does (hairdresser, barber, nails,
-- cosmetologist, brows and lashes, make-up, massage) plus the salon's own words. Shown to
-- clients on the booking page.

-- CreateEnum
CREATE TYPE "specialty" AS ENUM ('hairdresser', 'barber', 'nails', 'cosmetologist', 'brows_lashes', 'makeup', 'massage');

-- AlterTable
ALTER TABLE "staff_member" ADD COLUMN     "custom_specialty" TEXT,
ADD COLUMN     "specialties" "specialty"[] DEFAULT ARRAY[]::"specialty"[];
