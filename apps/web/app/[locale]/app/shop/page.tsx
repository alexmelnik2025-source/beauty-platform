'use client';

import { useSession } from '@/components/Session';
import { MyShopSection } from '@/components/shop/MyShopSection';

/** Task Q3 (part 2a): "Mój sklep" — what the salon sells to clients and shows in the "Sklep" tab. */
export default function ShopPage() {
  const { orgId, location } = useSession();
  // The same side margins and width as the other cabinet pages (it used to touch the screen's edges).
  return (
    <div className="page shop-page">
      <MyShopSection base={`/v1/organizations/${orgId}/locations/${location.id}`} />
    </div>
  );
}
