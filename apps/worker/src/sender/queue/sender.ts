// Порт отправителя сообщений (K-21a). Реализация клиента MAX — поток K-21b (apps/worker/src/sender/max/).
// Очередь зависит только от этого интерфейса, а не от конкретного клиента.

import type { Notification } from "@max-hackathon/domain";

/** Успешная отправка: сообщение принято MAX. */
export interface SendSuccess {
  ok: true;
}

/** Неуспешная отправка. Отправитель классифицирует ошибку сам: очередь не разбирает ответы MAX. */
export interface SendFailure {
  ok: false;
  /** Код ошибки для таксономии K-27, например `RATE_LIMITED`. Без ПДн. */
  code: string;
  /**
   * true — сообщение точно не доставлено и повтор безопасен (сеть до отправки запроса, 429, 5xx до приёма).
   * false — повтор бесполезен (чат не найден, бот заблокирован, неверный запрос).
   * Если исход неизвестен (таймаут после отправки запроса), верните retryable: false и код
   * {@link DELIVERY_UNKNOWN}: иначе возможен дубль.
   */
  retryable: boolean;
  /** Через сколько миллисекунд можно повторить (например, из Retry-After). */
  retryAfterMs?: number;
  /** Пояснение без ПДн: не включайте текст сообщения, chatId и ИНН. */
  message?: string;
}

export type SendResult = SendSuccess | SendFailure;

export interface MessageSender {
  /**
   * Отправить одно уведомление. Не должен бросать исключения: ошибки возвращаются как SendFailure.
   * Исключение очередь считает неизвестным исходом (см. {@link DELIVERY_UNKNOWN}).
   * notification.idempotencyKey стоит передать в MAX, если API поддерживает ключ идемпотентности.
   * Реализация обязана выполнять HTTP-вызов через общий MaxApiTransport, разделяемый с upload и
   * service-клиентами. Очередь отвечает только за per-chat лимит и не может учитывать иные MAX-запросы.
   */
  send(notification: Notification): Promise<SendResult>;
}

// Коды ошибок, которые выставляет сама очередь (таксономия K-27).

/** Отметка «отправка начата» у уведомления в статусе queued. Сбой воркера оставляет её в БД. */
export const DELIVERY_IN_PROGRESS = "delivery_in_progress";
/** Исход отправки неизвестен (воркер упал после начала отправки или отправитель бросил исключение). */
export const DELIVERY_UNKNOWN = "delivery_unknown";
/** Код ошибки отправителя, который очередь выставляет, когда отправитель не вернул результат. */
export const SENDER_EXCEPTION = "sender_exception";
