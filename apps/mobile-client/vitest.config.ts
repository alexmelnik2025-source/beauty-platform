import { defineConfig } from 'vitest/config';

// Logic without React Native (API client, dates, translations) — runs in Node.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } });
