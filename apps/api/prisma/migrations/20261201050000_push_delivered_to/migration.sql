-- Devices that already got a push notification: a retry after a partial failure skips them (task 620).
ALTER TABLE "notification" ADD COLUMN     "push_delivered_to" UUID[] DEFAULT ARRAY[]::UUID[];
