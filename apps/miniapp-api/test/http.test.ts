import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest, ApiResponse } from "../src/api.js";
import { createHttpServer } from "../src/http.js";

const servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("miniapp HTTP adapter", () => {
  it("routes the deployed /api prefix and ignores client company query parameters", async () => {
    const handle = vi.fn(async (_request: ApiRequest): Promise<ApiResponse> => ({ status: 200, body: { ok: true } }));
    const server = createHttpServer(handle);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/profile?companyId=foreign-company`, {
      headers: { authorization: "Bearer model_session_token_1234567890" },
    });

    expect(response.status).toBe(200);
    expect(handle).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/profile",
      authorization: "Bearer model_session_token_1234567890",
    });
  });
});
