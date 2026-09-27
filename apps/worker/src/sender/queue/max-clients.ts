// Upload- и service-клиенты MAX Bot API. Как и MaxMessageSender, не принимают fetch: каждый вызов идёт
// через общий MaxApiTransport и расходует токен той же квоты, что и отправка сообщений.

import type { MaxApiRequest, MaxApiTransport } from "./max-transport.js";

/** Загрузка вложений (файлы, изображения) перед отправкой сообщения. */
export class MaxUploadClient {
  constructor(private readonly transport: MaxApiTransport) {}

  upload(request: MaxApiRequest): Promise<Response> {
    return this.transport.upload(request);
  }
}

/** Служебные запросы: ответы на callback, сведения о боте и чатах. */
export class MaxServiceClient {
  constructor(private readonly transport: MaxApiTransport) {}

  request(request: MaxApiRequest): Promise<Response> {
    return this.transport.service(request);
  }
}
