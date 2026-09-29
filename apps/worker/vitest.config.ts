import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite WASM startup and migrations belong to hooks, not the 5-second test budget.
    hookTimeout: 30_000,
  },
});
