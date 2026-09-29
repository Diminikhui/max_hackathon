import { defineConfig } from "vitest/config";

// Тесты поднимают PGlite и настоящий HTTP-сервер: запуск базы вынесен в хуки с отдельным лимитом.
export default defineConfig({
  test: { hookTimeout: 60_000, testTimeout: 30_000 },
});
