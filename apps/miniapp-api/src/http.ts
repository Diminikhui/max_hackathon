import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ApiRequest, ApiResponse } from "./api.js";

const BODY_LIMIT_BYTES = 16 * 1024;

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const send = (response: ServerResponse, result: ApiResponse): void => {
  if (result.body === undefined) {
    response.writeHead(result.status).end();
    return;
  }
  const body = JSON.stringify(result.body);
  response.writeHead(result.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
};

export const createHttpServer = (handle: (request: ApiRequest) => Promise<ApiResponse>) =>
  createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://miniapp-api.local");
      send(
        response,
        await handle({
          method: request.method ?? "GET",
          path: url.pathname,
          ...(typeof request.headers.authorization === "string"
            ? { authorization: request.headers.authorization }
            : {}),
          ...(["POST", "PUT", "PATCH"].includes(request.method ?? "") ? { body: await readJson(request) } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.message === "BODY_TOO_LARGE")) {
        send(response, { status: 400, body: { error: "INVALID_REQUEST" } });
        return;
      }
      send(response, { status: 500, body: { error: "INTERNAL_ERROR" } });
    }
  });
