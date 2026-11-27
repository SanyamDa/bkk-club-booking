import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test boots an embedded Postgres; give slow laptops and CI room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One file at a time: parallel embedded databases starve each other on busy machines.
    fileParallelism: false,
  },
});
