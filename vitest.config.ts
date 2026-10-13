import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/lib/__tests__/*.test.ts", "src/lib/wallet-agent/__tests__/*.test.ts", "src/lib/x402/__tests__/*.test.ts", "src/lib/payment-rails/__tests__/*.test.ts"],
    setupFiles: ["test/support/state-sandbox.ts", "test/support/cashu-network-sandbox.ts"],
    server: { deps: { inline: ["@dvmkit/sdk"] } },
    restoreMocks: true,
    clearMocks: true,
  },
});
