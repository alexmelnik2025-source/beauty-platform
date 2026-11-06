-- Task 209: the salon's public answer under a client's review.

-- AlterTable
ALTER TABLE "visit_review" ADD COLUMN     "replied_at" TIMESTAMPTZ(3),
ADD COLUMN     "reply" TEXT;
