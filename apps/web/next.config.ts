import type { NextConfig } from 'next';

/** Where the API runs. The browser only talks to this web server; /v1/* is passed on. */
const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const config: NextConfig = {
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
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
