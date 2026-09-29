// Точка входа процесса «Пульса» (K-30b): бот MAX, контур уведомлений демо-кнопки и отправка очереди.
// Сборка — ./app/runtime.ts. Процесс один: общие данные бота и уведомлений хранятся в его памяти.
import { createJsonLogSink, createLogger } from "@max-hackathon/observability";
import { readConfig } from "./app/config.js";
import { startApp } from "./app/runtime.js";

const logger = createLogger(createJsonLogSink((line) => process.stdout.write(`${line}\n`)));

try {
  const app = await startApp(readConfig(process.env), logger);
  const shutdown = (signal: string) => {
    logger.info("app.stopping", "Stopping on signal", { signal });
    app.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error("app.stop_failed", "Graceful stop failed", { error });
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
} catch (error) {
  logger.error("app.start_failed", "Process failed to start", { error });
  process.exit(1);
}
