import base from '@beauty/config/eslint';

export default [
  ...base,
  {
    ignores: [
      '.next/**',
      'next-env.d.ts',
      'playwright-report/**',
      'test-results/**',
      // Plain browser files served as they are (service worker): no bundler, browser globals.
      'public/**',
    ],
  },
];
