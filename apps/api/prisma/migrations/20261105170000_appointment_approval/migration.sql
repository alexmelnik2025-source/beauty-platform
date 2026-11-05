-- Task 161b: a visit booked online by a client the cancellation guard marks with "approval"
-- waits until the salon accepts it.

-- AlterTable
ALTER TABLE "appointment" ADD COLUMN     "approval_requested_at" TIMESTAMPTZ(3);
