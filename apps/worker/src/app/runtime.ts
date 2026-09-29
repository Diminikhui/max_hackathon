// K-30b. Точка сборки процесса: бот (K-22a транспорт, сценарии K-24/K-09/K-29), сервисы профиля и перечня
// (K-25b, K-26), хранилище (K-10), контур уведомлений демо-кнопки (K-30a) и отправка очереди в MAX (K-21).
// Всё в одном процессе: настройки, привязки «диалог ↔ компания» и получатели push живут в памяти и общие
// у бота и контура уведомлений (решение по сборке — комментарий в Issue #143).
import type { Server } from "node:http";
import { join } from "node:path";
import { FixtureProfileSource, loadFixtureProfiles, MspProfileSource } from "@max-hackathon/adapters";
import { type BotApp, type BotReplyPort, createBotApp } from "@max-hackathon/bot/dist/app/index.js";
import { DEMO_PACK_FILE, loadDemoPack } from "@max-hackathon/bot/dist/flows/demo/index.js";
import { createMemorySettingsStore } from "@max-hackathon/bot/dist/flows/settings/index.js";
import {
  createBotHttpServer,
  createInboundDispatcher,
  createMaxWebhookHandler,
  createMemoryDedup,
  type InboundDispatcher,
  type TransportLogger,
} from "@max-hackathon/bot/dist/transport/index.js";
import { ChecklistService, ProfileService } from "@max-hackathon/services";
import {
  createPgClient,
  PostgresNotificationRepository,
  PostgresProfileRepository,
  PostgresRequirementRepository,
  runMigrations,
  type SqlClient,
} from "@max-hackathon/storage";
import { NotificationPipeline, PostgresNotificationHistory, runRulepackNotifications } from "../notify/index.js";
import { MaxMessageSender } from "../sender/max/index.js";
import type { MessageSender } from "../sender/queue/index.js";
import { defaultMaxTransportRegistry, runSendLoop, SendQueueWorker } from "../sender/queue/index.js";
import type { AppConfig } from "./config.js";
import { modelProfilesOnly, onlyPack, UNCONSUMED_EVENTS } from "./demo.js";
import { createMaxReplyPort } from "./max-reply.js";
import { createProfileGateway } from "./profiles.js";
import { REPO_ROOT, seedRulepacks, withModelPackBoundary } from "./rulepacks.js";

export interface AppAssembly {
  readonly bot: BotApp;
  readonly queue: SendQueueWorker;
  readonly notifications: PostgresNotificationRepository;
}

export interface AssembleOptions {
  readonly db: SqlClient;
  readonly reply: BotReplyPort;
  readonly sender: MessageSender;
  readonly logger: TransportLogger;
  /** Реальный источник профиля для ИНН не из K-28. По умолчанию — реестр МСП. */
  readonly realSource?: ConstructorParameters<typeof ProfileService>[0]["source"];
  readonly now?: () => Date;
  readonly root?: string;
}

/** Сборка без сети и HTTP-сервера: её же проходят тесты на PGlite с модельной отправкой. */
export const assembleApp = async (options: AssembleOptions): Promise<AppAssembly> => {
  const { db, logger } = options;
  const now = options.now ?? (() => new Date());
  const clock = () => now().toISOString();
  const root = options.root ?? REPO_ROOT;

  await runMigrations(db);
  const profileRepository = new PostgresProfileRepository(db);
  const requirements = new PostgresRequirementRepository(db);
  const notifications = new PostgresNotificationRepository(db);

  const seeded = await seedRulepacks(requirements, undefined, root);
  logger.info("app.rulepacks.seeded", "Rulepacks are in storage", {
    installed: seeded.installed,
    skipped: seeded.skipped,
  });

  const modelCompanies = loadFixtureProfiles();
  const profiles = createProfileGateway({
    model: new ProfileService({
      source: new FixtureProfileSource(modelCompanies),
      repository: profileRepository,
      clock,
    }),
    real: new ProfileService({
      source: options.realSource ?? new MspProfileSource(),
      repository: profileRepository,
      clock,
    }),
    modelInns: new Set(modelCompanies.map((company) => company.inn)),
  });
  const checklist = withModelPackBoundary(
    new ChecklistService({ profiles: profileRepository, requirements, clock }),
    profileRepository,
    requirements,
    seeded.modelPackIds,
  );

  const settings = createMemorySettingsStore();
  const demoPack = await loadDemoPack(join(root, DEMO_PACK_FILE));

  // Получатели push — тот же справочник, что строит бот: последний чат, в котором выбрана компания.
  let bot: BotApp | undefined;
  const recipients = {
    chatFor: (companyId: string) => (bot ? bot.directory.chatFor(companyId) : Promise.resolve(undefined)),
  };
  const demoPipeline = new NotificationPipeline({
    profiles: modelProfilesOnly(profileRepository),
    notifications,
    recipients,
    history: new PostgresNotificationHistory(db),
    settings,
    now,
  });

  bot = createBotApp({
    profiles,
    checklist,
    settings,
    logger,
    reply: options.reply,
    demo: {
      pack: demoPack,
      requirements,
      notifications,
      now: clock,
      runNotifications: () =>
        runRulepackNotifications({
          requirements: onlyPack(requirements, demoPack.packId),
          events: UNCONSUMED_EVENTS,
          pipeline: demoPipeline,
          now: clock,
        }),
    },
  });

  const queue = new SendQueueWorker({ repository: notifications, sender: options.sender, now: () => now().getTime() });
  return { bot, queue, notifications };
};

export interface RunningApp {
  stop(): Promise<void>;
}

/** Запуск на сервере: PostgreSQL, приём webhook MAX, отправка ответов и очереди уведомлений. */
export const startApp = async (config: AppConfig, logger: TransportLogger): Promise<RunningApp> => {
  const db = createPgClient(config.databaseUrl);

  if (!config.maxEventsEnabled || config.max === undefined) {
    // Локальный контур (ADR-0003): база и пакеты готовятся, события MAX не принимаются и ничего не отправляется.
    await runMigrations(db);
    await seedRulepacks(new PostgresRequirementRepository(db));
    logger.info("app.max.disabled", "MAX events are disabled: set MAX_EVENTS_ENABLED=true on the server");
    return { stop: () => db.close() };
  }

  const transport = defaultMaxTransportRegistry.forToken({ token: config.max.token, baseUrl: config.max.baseUrl });
  const { bot, queue } = await assembleApp({
    db,
    logger,
    reply: createMaxReplyPort(transport, logger),
    sender: new MaxMessageSender({ transport }),
  });

  const dispatcher: InboundDispatcher = createInboundDispatcher({ handle: bot.handle, logger });
  const webhook = createMaxWebhookHandler({
    secret: config.max.webhookSecret,
    dispatcher,
    dedup: createMemoryDedup(),
    logger,
  });
  const server: Server = createBotHttpServer({ webhook });
  await new Promise<void>((resolve) => server.listen(config.botHttpPort, config.botHttpHost, resolve));
  logger.info("app.started", "Bot is listening for MAX webhook", { port: config.botHttpPort });

  const abort = new AbortController();
  const sending = runSendLoop(queue, {
    signal: abort.signal,
    onError: (error) => logger.error("app.send_loop.failed", "Send queue iteration failed", { error }),
  });

  return {
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await dispatcher.drain();
      abort.abort();
      await sending;
      await db.close();
    },
  };
};
