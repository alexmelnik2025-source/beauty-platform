import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Shared ESLint rules for TypeScript packages. */
export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'src/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-console': 'error',
    },
  },
);
