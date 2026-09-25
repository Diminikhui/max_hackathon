// МОДЕЛЬНЫЙ отправитель для тестов и демо без MAX: ничего не отправляет, только записывает вызовы.
// Не имитирует реальную интеграцию; настоящий клиент MAX — поток K-21b.

import type { Notification } from "@max-hackathon/domain";
import type { MessageSender, SendResult } from "./sender.js";

/** Сценарий ответа: результат или исключение. */
export type FakeSendStep = SendResult | { throws: string };

export class FakeMessageSender implements MessageSender {
  /** Модельные «доставленные» сообщения: id и idempotencyKey по порядку вызовов. */
  readonly calls: { id: string; idempotencyKey: string }[] = [];
  private readonly script: FakeSendStep[];

  /** script — ответы по порядку вызовов; когда он закончится, отвечает { ok: true }. */
  constructor(script: FakeSendStep[] = []) {
    this.script = [...script];
  }

  async send(notification: Notification): Promise<SendResult> {
    this.calls.push({ id: notification.id, idempotencyKey: notification.idempotencyKey });
    const step = this.script.shift() ?? { ok: true };
    if ("throws" in step) throw new Error(step.throws);
    return step;
  }

  /** Сколько раз отправлялось уведомление с этим idempotencyKey. */
  countFor(idempotencyKey: string): number {
    return this.calls.filter((call) => call.idempotencyKey === idempotencyKey).length;
  }
}
