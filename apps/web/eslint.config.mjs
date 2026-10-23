import base from '@beauty/config/eslint';

export default [
  ...base,
  { ignores: ['.next/**', 'next-env.d.ts', 'playwright-report/**', 'test-results/**'] },
];
