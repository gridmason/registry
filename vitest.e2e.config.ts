import { defineConfig } from 'vitest/config';

// The full-chain e2e (FR-13) is a separate gate from the fast unit run
// (`npm test`): it drives real HTTP against a compose-launched instance (the
// R-E0 Postgres + object store), so it is slower and needs the stack up. Keeping
// it in its own config lets CI run it as a dedicated job (`docs/e2e.md`) while the
// unit config stays infra-free. Run it with `npm run test:e2e`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.e2e.ts'],
    // The chain is sequential and shares one booted server across the file; give
    // the boot (compose readiness + migrations already applied) room, and run the
    // single file in-band.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
