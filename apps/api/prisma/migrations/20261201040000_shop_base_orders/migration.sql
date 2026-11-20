-- Task Q4 (part 5): products put aside for a visit go to the seller's Base as orders
-- ("Zamówienia do Base"), and their status follows the reservation (handed over / cancelled).

-- AlterEnum
ALTER TYPE "shop_sync_trigger" ADD VALUE 'orders';

-- AlterTable
ALTER TABLE "shop_integration" ADD COLUMN     "orders_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "order_status_new_id" TEXT,
ADD COLUMN     "order_status_handed_id" TEXT,
ADD COLUMN     "order_status_cancelled_id" TEXT;

-- AlterTable
ALTER TABLE "product_reservation" ADD COLUMN     "base_order_id" TEXT,
ADD COLUMN     "base_order_state" TEXT,
ADD COLUMN     "base_order_fails" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "base_order_error" TEXT;
