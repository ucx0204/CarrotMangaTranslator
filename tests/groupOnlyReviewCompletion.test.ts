import { afterEach, describe, expect, it, vi } from "vitest";

const { requestGroupOnlyCropCompletion } =
  require("../src/main/runtime/transport/group-only-review-completion.cjs") as {
    requestGroupOnlyCropCompletion: (
      server: { baseUrl: string },
      options: Record<string, unknown> & {
        ocrBboxHints: Record<string, unknown>[];
      },
      payload: Record<string, unknown>,
      variant: { role: string; path: string; dataUrl: string },
      requestVersion: number,
    ) => Promise<{ outputText: string; rawResponse: unknown }>;
  };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("group-only review completion transport", () => {
  it("uses the Responses token field and tolerates a missing case payload", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          [
            "event: response.output_text.delta",
            'data: {"type":"response.output_text.delta","delta":"{\\"labels\\":[]}"}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_group","status":"completed","output":[]}}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestGroupOnlyCropCompletion(
        { baseUrl: "https://codex.invalid/v1" },
        {
          modelProvider: "openai-codex",
          codexModel: "gpt-test",
          codexReasoningEffort: "low",
          maxTokens: 1024,
          ocrBboxHints: [],
        },
        {
          prompt: "Return labels.",
          systemPrompt: "Return JSON.",
          candidateOrder: [],
          case: null,
          responseFormat: {
            schema: {
              type: "object",
              properties: { labels: { type: "array", items: {} } },
              required: ["labels"],
              additionalProperties: false,
            },
          },
        },
        {
          role: "semantic-review-crop",
          path: "crop.png",
          dataUrl: "data:image/png;base64,Y3JvcA==",
        },
        5,
      ),
    ).resolves.toMatchObject({ outputText: '{"labels":[]}' });

    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(body.max_output_tokens).toBe(900);
    expect(body).not.toHaveProperty("max_tokens");
  });
});
