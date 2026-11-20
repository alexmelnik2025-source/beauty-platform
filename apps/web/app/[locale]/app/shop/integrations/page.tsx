'use client';

import { useSession } from '@/components/Session';
import { ShopIntegrationsSection } from '@/components/shop/ShopIntegrationsSection';
import { useI18n } from '@/lib/i18n';

/** Task Q4: "Integracje" — the seller's products from its own Base or a product file. */
export default function ShopIntegrationsPage() {
  const { orgId, location, role } = useSession();
  const { t } = useI18n();
  if (role === 'staff') return <p className="muted">{t.shopIntegrations.ownersOnly}</p>;
  return (
    <div className="page">
      <ShopIntegrationsSection base={`/v1/organizations/${orgId}/locations/${location.id}`} />
    </div>
  );
}
