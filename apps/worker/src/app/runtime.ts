// K-30b. Точка сборки процесса: бот (K-22a транспорт, сценарии K-24/K-09/K-29), сервисы профиля и перечня
// (K-25b, K-26), хранилище (K-10), контур уведомлений демо-кнопки (K-30a) и отправка очереди в MAX (K-21).
// Всё в одном процессе: бот и контур уведомлений читают одни настройки и один справочник получателей push
// (решение по сборке — комментарий в Issue #143). Состояние диалога, привязки и настройки хранятся в PostgreSQL
// (#312), поэтому перезапуск процесса диалог не сбрасывает.
import type { Server } from "node:http";
import { join } from "node:path";
import { FixtureProfileSource, loadFixtureProfiles, MspProfileSource } from "@max-hackathon/adapters";
import { type BotApp, type BotReplyPort, createBotApp } from "@max-hackathon/bot/dist/app/index.js";
import { renderCoverageNotice } from "@max-hackathon/bot/dist/flows/coverage/index.js";
import { DEMO_PACK_FILE, loadDemoPack } from "@max-hackathon/bot/dist/flows/demo/index.js";
import { selectExampleCompanies } from "@max-hackathon/bot/dist/flows/examples/index.js";
import type { ExplainProviderChoice } from "@max-hackathon/bot/dist/flows/explain/index.js";
import type { PendingProfile } from "@max-hackathon/bot/dist/flows/onboarding/index.js";
import {
  createBotHttpServer,
  createInboundDispatcher,
  createMaxWebhookHandler,
  createMemoryDedup,
  type InboundDispatcher,
  type TransportLogger,
} from "@max-hackathon/bot/dist/transport/index.js";
import {
  ActionQueueService,
  type ChecklistOutcome,
  ChecklistService,
  describeCoverage,
  ProfileService,
  ScenarioDeltaService,
} from "@max-hackathon/services";
import {
  createPgClient,
  PostgresBotDialogRepository,
  PostgresChatDirectoryRepository,
  PostgresClarifySkipRepository,
  PostgresNotificationRepository,
  PostgresNotificationSettingsRepository,
  PostgresProfileRepository,
  PostgresRequirementRepository,
  runMigrations,
  type SqlClient,
} from "@max-hackathon/storage";
import { NotificationPipeline, PostgresNotificationHistory, runRulepackNotifications } from "../notify/index.js";
import { MaxMessageSender } from "../sender/max/index.js";
import type { MessageSender } from "../sender/queue/index.js";
import {
  defaultMaxTransportRegistry,
  type MaxFetch,
  type MaxTransportRegistry,
  runSendLoop,
  SendQueueWorker,
} from "../sender/queue/index.js";
import type { AppConfig } from "./config.js";
import { demoNotificationSink, modelProfilesOnly, onlyPack, UNCONSUMED_EVENTS } from "./demo.js";
import { createMaxReplyPort } from "./max-reply.js";
import { createProfileGateway, freshModelProfiles } from "./profiles.js";
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
  /** 2-22: пересказ «Простым языком». Без него кнопки на карточке нет. */
  readonly explain?: ExplainProviderChoice;
  readonly botFeatures?: readonly string[];
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
      repository: freshModelProfiles(profileRepository),
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

  const settings = new PostgresNotificationSettingsRepository(db);
  const dialogs = new PostgresBotDialogRepository<PendingProfile>(db);
  const demoPack = await loadDemoPack(join(root, DEMO_PACK_FILE));

  // Получатели push — тот же справочник, что строит бот: последний чат, в котором выбрана компания.
  const recipients = new PostgresChatDirectoryRepository(db);
  const demoPipeline = new NotificationPipeline({
    profiles: modelProfilesOnly(profileRepository),
    notifications: demoNotificationSink(notifications),
    recipients,
    history: new PostgresNotificationHistory(db),
    settings,
    now,
  });

  const bot = createBotApp({
    profiles,
    checklist,
    settings,
    sessions: dialogs,
    states: dialogs,
    skips: new PostgresClarifySkipRepository(db),
    directory: recipients,
    logger,
    reply: options.reply,
    // K-34: бот получает тот же объект, что вернул `checklist.build` (`ChecklistService`), поэтому профиль в нём полный.
    coverageNotice: (outcome) => {
      const { profile, checklist: built } = outcome as unknown as Extract<ChecklistOutcome, { status: "ok" }>;
      return renderCoverageNotice(describeCoverage(profile, built));
    },
    ...(options.botFeatures?.includes("deadlines")
      ? { deadlines: { queue: new ActionQueueService({ checklists: checklist }) } }
      : {}),
    ...(options.botFeatures?.includes("whatif")
      ? { whatif: { delta: new ScenarioDeltaService({ profiles: profileRepository, requirements, clock }) } }
      : {}),
    ...(options.explain ? { explain: { provider: options.explain.provider } } : {}),
    ...(options.botFeatures?.includes("examples") ? { examples: selectExampleCompanies(modelCompanies) } : {}),
    demo: {
      pack: demoPack,
      // Кнопка «Открыть карточку» включается флагом `cards`, когда корень сайта отдаёт мини-приложение (Issue #347).
      ...(options.botFeatures?.includes("cards") ? { cardLink: true } : {}),
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

  // Опрос пустой очереди раз в секунду: демо-уведомление приходит вслед за ответом на кнопку, а не через 5 с.
  const queue = new SendQueueWorker({
    repository: notifications,
    sender: options.sender,
    now: () => now().getTime(),
    idleDelayMs: 1_000,
  });
  return { bot, queue, notifications };
};

export interface RunningApp {
  /** Порт, на котором слушает HTTP-сервер бота; `undefined`, если события MAX выключены. */
  readonly port: number | undefined;
  stop(): Promise<void>;
}

/** Подмена внешних зависимостей для e2e-тестов: база, HTTP-клиент MAX, реестр транспортов. */
export interface StartOptions {
  /** Готовое подключение к базе вместо `DATABASE_URL` (PGlite в тестах). Закрывается при `stop()`. */
  readonly db?: SqlClient & { close(): Promise<void> };
  /** HTTP-клиент для запросов к MAX; по умолчанию глобальный `fetch`. */
  readonly fetch?: MaxFetch;
  /** Реестр транспортов; тест берёт свой, чтобы не делить лимит запросов с другими тестами. */
  readonly registry?: MaxTransportRegistry;
  /** Источник профиля для ИНН не из K-28; по умолчанию реестр МСП. */
  readonly realSource?: AssembleOptions["realSource"];
  readonly now?: () => Date;
}

/** Запуск на сервере: PostgreSQL, приём webhook MAX, отправка ответов и очереди уведомлений. */
export const startApp = async (
  config: AppConfig,
  logger: TransportLogger,
  options: StartOptions = {},
): Promise<RunningApp> => {
  const db = options.db ?? createPgClient(config.databaseUrl);

  if (!config.maxEventsEnabled || config.max === undefined) {
    // Локальный контур (ADR-0003): база и пакеты готовятся, события MAX не принимаются и ничего не отправляется.
    await runMigrations(db);
    await seedRulepacks(new PostgresRequirementRepository(db));
    logger.info("app.max.disabled", "MAX events are disabled: set MAX_EVENTS_ENABLED=true on the server");
    return { port: undefined, stop: () => db.close() };
  }

  if (config.explain) {
    // Имя провайдера и причина отката — без значения ключа.
    logger.info("app.explain.enabled", "Plain-language retelling is enabled", {
      provider: config.explain.provider.name,
      ...(config.explain.fallbackReason ? { fallbackReason: config.explain.fallbackReason } : {}),
    });
  }

  const registry = options.registry ?? defaultMaxTransportRegistry;
  const transport = registry.forToken({
    token: config.max.token,
    baseUrl: config.max.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const { bot, queue } = await assembleApp({
    db,
    logger,
    reply: createMaxReplyPort(transport, logger),
    sender: new MaxMessageSender({ transport }),
    ...(config.explain ? { explain: config.explain } : {}),
    ...(config.botFeatures ? { botFeatures: config.botFeatures } : {}),
    ...(options.realSource ? { realSource: options.realSource } : {}),
    ...(options.now ? { now: options.now } : {}),
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
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.botHttpPort;
  logger.info("app.started", "Bot is listening for MAX webhook", { port });

  const abort = new AbortController();
  const sending = runSendLoop(queue, {
    signal: abort.signal,
    onError: (error) => logger.error("app.send_loop.failed", "Send queue iteration failed", { error }),
  });

  return {
    port,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await dispatcher.drain();
      abort.abort();
      await sending;
      await db.close();
    },
  };
};
