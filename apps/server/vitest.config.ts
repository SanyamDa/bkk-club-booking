import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test boots an embedded Postgres; give slow laptops and CI room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each file gets its own embedded Postgres; cap workers so busy machines do not starve. Override with VITEST_MAX_WORKERS.
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 4),
  },
});
