import { toDialogEvent } from "./dialog-event.js";
import type { InboundEvent, InboundHandler, TransportLogger } from "./types.js";

export interface InboundDispatcher {
  /**
   * Ставит событие в обработку и сразу возвращает управление, чтобы webhook ответил MAX без ожидания сценария.
   * `false` — очередь переполнена, событие не принято.
   */
  dispatch(event: InboundEvent): boolean;
  /** Ждёт окончания всех принятых событий: для остановки процесса и для тестов. */
  drain(): Promise<void>;
  /** Сколько событий принято и ещё не обработано. */
  readonly pending: number;
}

export interface InboundDispatcherOptions {
  readonly handle: InboundHandler;
  readonly logger: TransportLogger;
  /** Лимит необработанных событий одного чата: защищает от чата, который шлёт сообщения быстрее обработки. */
  readonly maxPendingPerChat?: number;
  readonly maxPendingTotal?: number;
}

interface ChatLane {
  tail: Promise<void>;
  size: number;
}

/**
 * События одного чата обрабатываются строго по очереди: иначе два быстрых нажатия читали бы одно состояние диалога
 * и оба применяли переход. Разные чаты обрабатываются параллельно.
 */
export const createInboundDispatcher = ({
  handle,
  logger,
  maxPendingPerChat = 20,
  maxPendingTotal = 1_000,
}: InboundDispatcherOptions): InboundDispatcher => {
  const lanes = new Map<string, ChatLane>();
  let pending = 0;

  const run = async (event: InboundEvent): Promise<void> => {
    try {
      await handle({ event, dialogEvent: toDialogEvent(event) });
    } catch (error) {
      // Текст и id чата в лог не пишутся: только тип и id события.
      logger.error("bot.inbound.handler_failed", "Inbound event handler failed", {
        eventId: event.eventId,
        kind: event.kind,
        error,
      });
    }
  };

  return {
    dispatch(event) {
      const lane = lanes.get(event.chatId) ?? { tail: Promise.resolve(), size: 0 };
      if (lane.size >= maxPendingPerChat || pending >= maxPendingTotal) {
        logger.warn("bot.inbound.overloaded", "Inbound event dropped: queue is full", {
          eventId: event.eventId,
          kind: event.kind,
          pending,
        });
        return false;
      }

      lane.size += 1;
      pending += 1;
      lane.tail = lane.tail
        .then(() => run(event))
        .finally(() => {
          lane.size -= 1;
          pending -= 1;
          if (lane.size === 0) lanes.delete(event.chatId);
        });
      lanes.set(event.chatId, lane);
      return true;
    },

    async drain() {
      while (lanes.size > 0) {
        await Promise.all([...lanes.values()].map((lane) => lane.tail));
      }
    },

    get pending() {
      return pending;
    },
  };
};
