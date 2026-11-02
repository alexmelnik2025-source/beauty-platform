import type { NextConfig } from 'next';
import { join } from 'node:path';

/** Where the API runs. The browser only talks to this web server; /v1/* is passed on. */
const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  output: 'standalone',
  // Include the workspace packages used by @beauty/api-client in the runtime trace.
  outputFileTracingRoot: join(process.cwd(), '../..'),
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/v1/:path*', destination: `${apiUrl}/v1/:path*` }];
  },
  async redirects() {
    return [
      { source: '/', destination: '/pl', permanent: false },
      // Links in account emails have no language prefix.
      { source: '/verify-email', destination: '/pl/verify-email', permanent: false },
      { source: '/reset-password', destination: '/pl/reset-password', permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        // Nothing may be shown inside another site's frame…
        source: '/:path((?!(?:pl|uk|ru|en)/b/).*)',
        headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
      },
      {
        // …except the booking page: the salon's own site shows it in a window (public/embed.js).
        source: '/:locale(pl|uk|ru|en)/b/:slug',
        headers: [{ key: 'Content-Security-Policy', value: 'frame-ancestors *' }],
      },
    ];
  },
};

export default config;
