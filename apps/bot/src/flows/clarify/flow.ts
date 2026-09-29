import type { FactValue } from "@max-hackathon/domain";
import type { ChecklistOutcomeView, ChecklistSource, FlowReply } from "../checklist/index.js";
import { renderNoCompany } from "../checklist/index.js";
import { type ClarifyAction, decodeClarifyPayload } from "./payload.js";
import { planClarification } from "./plan.js";
import { questionFor } from "./questions.js";
import {
  changeSourceUrls,
  renderAnswerPreface,
  renderDeclareFailed,
  renderFinished,
  renderQuestion,
  statusChanges,
} from "./render.js";

/** Добавляет к ответу ссылки на первоисточники, упомянутые в тексте. */
const withSources = (reply: FlowReply, urls: readonly string[]): FlowReply =>
  urls.length === 0 ? reply : { ...reply, sourceUrls: [...new Set([...reply.sourceUrls, ...urls])] };

/** Порт сохранения ответа. `ProfileService.declare` (K-25b) подходит без переходника. */
export interface FactDeclarer {
  declare(
    companyId: string,
    key: string,
    value: FactValue,
  ): Promise<{ readonly status: string; readonly message?: string }>;
}

/** Пропущенные в текущем заходе вопросы: чтобы «Пропустить» не показывал тот же вопрос снова. */
export interface ClarifySkipStore {
  get(dialogId: string): Promise<readonly string[]>;
  set(dialogId: string, keys: readonly string[]): Promise<void>;
}

export const createMemorySkipStore = (): ClarifySkipStore => {
  const skipped = new Map<string, readonly string[]>();
  return {
    async get(dialogId) {
      return skipped.get(dialogId) ?? [];
    },
    async set(dialogId, keys) {
      if (keys.length === 0) skipped.delete(dialogId);
      else skipped.set(dialogId, [...keys]);
    },
  };
};

export interface ClarifyFlowDeps {
  readonly checklist: ChecklistSource;
  /** Компания, привязанная к диалогу после онбординга (K-24a). */
  readonly companyOf: (dialogId: string) => Promise<string | undefined>;
  readonly profiles: FactDeclarer;
  /** По умолчанию — в памяти процесса. */
  readonly skips?: ClarifySkipStore;
  /**
   * Вызывается после сохранения ответа, до пересчёта перечня. Сюда K-30b подключает пересчёт с событием
   * `profile_change` (`ProfileRecalculationService`), чтобы сохранённые статусы и уведомления увидели ответ.
   */
  readonly onDeclared?: (companyId: string, changedFactKeys: readonly string[]) => Promise<void>;
}

export interface ClarifyFlow {
  /** Обработать нажатие кнопки `c:…`. `undefined` — payload не относится к уточнению. */
  handle(dialogId: string, payload: string): Promise<FlowReply | undefined>;
  run(dialogId: string, action: ClarifyAction): Promise<FlowReply>;
}

type Loaded = Extract<ChecklistOutcomeView, { status: "ok" }> & { readonly companyId: string };

/**
 * Уточняющие вопросы (K-09). Бот спрашивает только о фактах из `missingFactKeys` записей «недостаточно данных»,
 * по одному вопросу за сообщение. Ответ сохраняется заявленным фактом, перечень строится заново, и следующий
 * вопрос выбирается по новому перечню: вопрос, который после ответа перестал влиять на результат, не задаётся.
 */
export const createClarifyFlow = (deps: ClarifyFlowDeps): ClarifyFlow => {
  const skips = deps.skips ?? createMemorySkipStore();

  const load = async (dialogId: string): Promise<Loaded | undefined> => {
    const companyId = await deps.companyOf(dialogId);
    if (companyId === undefined) return undefined;
    const outcome = await deps.checklist.build(companyId);
    return outcome.status === "ok" ? { ...outcome, companyId } : undefined;
  };

  /** Следующий вопрос по текущему перечню или итог, если спрашивать больше нечего. */
  const next = async (
    dialogId: string,
    loaded: Loaded,
    preface?: readonly string[],
    sourceUrls: readonly string[] = [],
  ): Promise<FlowReply> => withSources(await nextScreen(dialogId, loaded, preface), sourceUrls);

  const nextScreen = async (dialogId: string, loaded: Loaded, preface?: readonly string[]): Promise<FlowReply> => {
    const skippedKeys = await skips.get(dialogId);
    const plan = planClarification(loaded.checklist, new Set(skippedKeys));
    const question = plan.questions[0];
    const isModel = loaded.profile.isModel;
    if (question === undefined) {
      await skips.set(dialogId, []);
      return renderFinished({
        checklist: loaded.checklist,
        plan,
        profileIsModel: isModel,
        ...(preface ? { preface } : {}),
      });
    }
    return renderQuestion({ question, plan, isModel, ...(preface ? { preface } : {}) });
  };

  const answer = async (dialogId: string, key: string, optionIndex: number): Promise<FlowReply> => {
    const before = await load(dialogId);
    if (before === undefined) return renderNoCompany();

    const question = questionFor(key);
    const option = question?.options[optionIndex];
    if (question === undefined || option === undefined) {
      return next(dialogId, before, ["Эта кнопка устарела. Продолжим с актуального вопроса."]);
    }
    // Кнопка из старого сообщения (в том числе после смены компании): вопрос сейчас не задаётся, ответ не пишем.
    // Пропущенные вопросы по-прежнему принимают ответ, поэтому план строится без учёта пропусков.
    if (!planClarification(before.checklist).questions.some((candidate) => candidate.key === key)) {
      return next(dialogId, before, ["Эта кнопка устарела: сейчас этот вопрос не задаётся. Продолжим с актуального."]);
    }

    const outcome = await deps.profiles.declare(before.companyId, key, option.value);
    if (outcome.status === "company_not_found") return renderNoCompany();
    if (outcome.status !== "ok") {
      const plan = planClarification(before.checklist);
      return renderDeclareFailed({ question, plan, isModel: before.profile.isModel }, outcome.message);
    }
    await deps.onDeclared?.(before.companyId, [key]);

    const after = await load(dialogId);
    if (after === undefined) return renderNoCompany();
    const changes = statusChanges(before.checklist, after.checklist);
    return next(dialogId, after, renderAnswerPreface(option, changes), changeSourceUrls(changes));
  };

  const run = async (dialogId: string, action: ClarifyAction): Promise<FlowReply> => {
    switch (action.type) {
      case "answer":
        return answer(dialogId, action.key, action.option);
      case "start":
        // Новый заход: пропущенные ранее вопросы задаются снова.
        await skips.set(dialogId, []);
        break;
      case "skip": {
        const skipped = await skips.get(dialogId);
        if (!skipped.includes(action.key)) await skips.set(dialogId, [...skipped, action.key]);
        break;
      }
      case "finish":
        break;
    }

    const loaded = await load(dialogId);
    if (loaded === undefined) return renderNoCompany();
    if (action.type !== "finish") return next(dialogId, loaded);

    await skips.set(dialogId, []);
    return renderFinished({
      checklist: loaded.checklist,
      plan: planClarification(loaded.checklist),
      profileIsModel: loaded.profile.isModel,
    });
  };

  return {
    run,
    async handle(dialogId, payload) {
      const action = decodeClarifyPayload(payload);
      return action === undefined ? undefined : run(dialogId, action);
    },
  };
};
