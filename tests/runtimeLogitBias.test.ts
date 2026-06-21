import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTempDir,
  requestTranslation,
  restoreEnv,
} from "./helpers/runtimeModelContracts";

type BiasResult = {
  applied: boolean;
  bias?: number;
  tokenIds: number[];
  tokenTexts: string[];
  source: string;
  skippedReason?: string | null;
};

type LogitBiasModule = {
  applyLocalForbiddenTokenBias: (
    server: { baseUrl: string },
    options: Record<string, unknown>,
    requestBody: Record<string, unknown>,
  ) => Promise<BiasResult>;
  clearLocalForbiddenTokenBiasCache: () => void;
};

const { applyLocalForbiddenTokenBias, clearLocalForbiddenTokenBiasCache } =
  require("../src/main/runtime/simple-page-logit-bias.cjs") as LogitBiasModule;

afterEach(() => {
  clearLocalForbiddenTokenBiasCache();
  vi.unstubAllGlobals();
});

describe("local llama logit bias helpers", () => {
  it("adds configured forbidden token ids without a tokenizer request", async () => {
    const previousIds = process.env.MANGA_TRANSLATOR_FORBIDDEN_TOKEN_IDS;
    process.env.MANGA_TRANSLATOR_FORBIDDEN_TOKEN_IDS = "777, 888";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const requestBody: Record<string, unknown> = {
        logit_bias: { "12": -5 },
      };
      const result = await applyLocalForbiddenTokenBias(
        { baseUrl: "http://127.0.0.1:18181/v1" },
        {},
        requestBody,
      );

      expect(result).toMatchObject({
        applied: true,
        bias: -100,
        source: "configured-token-ids",
        tokenIds: [777, 888],
      });
      expect(requestBody.logit_bias).toEqual({
        "12": -5,
        "777": -100,
        "888": -100,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv("MANGA_TRANSLATOR_FORBIDDEN_TOKEN_IDS", previousIds);
    }
  });

  it("resolves unused49 through llama tokenize before translation requests", async () => {
    const previousIds = process.env.MANGA_TRANSLATOR_FORBIDDEN_TOKEN_IDS;
    const previousTexts = process.env.MANGA_TRANSLATOR_FORBIDDEN_TOKEN_TEXTS;
    delete process.env.MANGA_TRANSLATOR_FORBIDDEN_TOKEN_IDS;
    delete process.env.MANGA_TRANSLATOR_FORBIDDEN_TOKEN_TEXTS;

    const outputDir = createTempDir("logit-bias-");
    const imagePath = join(outputDir, "page.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    let chatBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          content?: string;
        };
        if (url.endsWith("/tokenize")) {
          return new Response(
            JSON.stringify({
              tokens: body.content === "<unused49>" ? [777] : [101, 102],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/chat/completions")) {
          chatBody = JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >;
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"items":[]}' } }],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await requestTranslation(
        { baseUrl: "http://127.0.0.1:18182/v1" },
        {
          label: "logit-bias-test",
          modelProvider: "gemma",
          imagePath,
          outputDir,
          imageWidth: 100,
          imageHeight: 100,
          maxTokens: 256,
          temperature: 0.2,
          topP: 0.95,
          topK: 64,
          ocrBboxHints: [
            {
              id: 1,
              label: "text",
              x1: 10,
              y1: 20,
              x2: 80,
              y2: 90,
              ocrText: "日本語",
            },
          ],
        },
      );

      expect(result.outputText).toBe('{"items":[]}');
      expect((chatBody as Record<string, unknown> | null)?.logit_bias).toEqual({
        "777": -100,
      });
      expect(result.requestBody.localForbiddenTokenBias).toMatchObject({
        applied: true,
        tokenIds: [777],
        source: "tokenize",
      });
      expect(
        fetchMock.mock.calls.some(
          ([input]) => String(input) === "http://127.0.0.1:18182/tokenize",
        ),
      ).toBe(true);
    } finally {
      restoreEnv("MANGA_TRANSLATOR_FORBIDDEN_TOKEN_IDS", previousIds);
      restoreEnv("MANGA_TRANSLATOR_FORBIDDEN_TOKEN_TEXTS", previousTexts);
    }
  });
});
