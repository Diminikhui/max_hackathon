// Responses are model data shaped after the public GetProjectStageInfo endpoint.
import { describe, expect, it } from "vitest";
import { extractProjectText, loadProjectText, toPlainProjectText } from "../../../src/ingest/text/index.js";

describe("project text extraction", () => {
  it("turns allow-listed HTML fields into inert plain text", () => {
    const result = extractProjectText({
      metadata: { title: "must not be collected", department: "must not be collected" },
      stage: {
        annotation: "<p>Проект&nbsp;акта</p><script>ignore()</script>",
        documents: [{ documentText: "Пункт 1.<br>Пункт 2 &amp; 3" }, { content: "Пункт 1.<br>Пункт 2 &amp; 3" }],
      },
    });
    expect(result).toEqual({
      text: "Проект акта\n\nПункт 1.\nПункт 2 & 3",
      fieldPaths: ["$.stage.annotation", "$.stage.documents[0].documentText"],
      truncated: false,
    });
    expect(toPlainProjectText("<style>bad</style><p>A&#x20;B</p>")).toBe("A B");
  });

  it("limits untrusted payload size and depth", () => {
    expect(extractProjectText({ text: "123456789" }, { maxCharacters: 5 })).toEqual({
      text: "12345",
      fieldPaths: ["$.text"],
      truncated: true,
    });
    expect(extractProjectText({ a: { b: { text: "hidden" } } }, { maxDepth: 1 }).truncated).toBe(true);
  });

  it("loads stage JSON and fails closed on unsupported responses", async () => {
    const calls: string[] = [];
    const fetch = async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ project: { description: "<p>Модельный текст</p>" } }));
    };
    await expect(loadProjectText("model/42", { fetch })).resolves.toMatchObject({ text: "Модельный текст" });
    expect(calls).toEqual(["https://regulation.gov.ru/api/public/PublicProjects/GetProjectStageInfo/model%2F42/0"]);

    await expect(
      loadProjectText("42", { fetch: async () => new Response(JSON.stringify({ title: "only title" })) }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
    await expect(loadProjectText("42", { fetch: async () => new Response("html") })).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
  });
});
