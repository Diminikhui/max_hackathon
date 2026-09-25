import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite (WASM) и миграции поднимаются один раз в beforeAll; на медленном раннере CI это занимает секунды.
    // Лимит самих тестов (5 с) не меняем: они должны укладываться в него без запуска БД.
    hookTimeout: 30_000,
  },
});
