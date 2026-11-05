import type { MetadataRoute } from 'next';
import { indexingEnabled, siteUrl } from '@/lib/seo';

// Read PUBLIC_INDEXING when asked, not when the image is built.
export const dynamic = 'force-dynamic';

/**
 * robots.txt (task 130). Until the owner switches indexing on (PUBLIC_INDEXING=1) nothing is
 * crawled. Then only the catalogue and the salons' booking pages are: never the salon
 * dashboard, "My visits", visit links or the API.
 */
export default function robots(): MetadataRoute.Robots {
  if (!indexingEnabled()) return { rules: { userAgent: '*', disallow: '/' } };
  return {
    rules: {
      userAgent: '*',
      allow: ['/*/salons', '/*/b/'],
      disallow: [
        '/v1/',
        '/*/app',
        '/*/c',
        '/*/m/',
        '/*/w/',
        '/*/u/',
        '/*/invite/',
        '/*/login',
        '/s/',
      ],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
