import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({ resolve: { alias: { 'cloudflare:workers': path.resolve('apps/openchat-manager/test/durable-object-stub.ts') } }, test: { environment: 'node', include: ['test/**/*.test.ts', 'apps/openchat-manager/src/**/*.test.ts'] } });
