import { describe, expect, it } from "vitest";

const { buildSemanticStageRequestBody, resolveStructuredTokenBudget } =
  require("../src/main/runtime/transport/semantic-ocr-request-builders.cjs") as {
    buildSemanticStageRequestBody: (
      options: Record<string, unknown>,
      messages: unknown[],
      responseFormat: Record<string, unknown>,
      stage: "grouping" | "translation",
      unitCount: number,
    ) => Record<string, unknown>;
    resolveStructuredTokenBudget: (
      options: Record<string, unknown>,
      stage: "grouping" | "translation",
      unitCount: number,
    ) => { maxTokens: number; source: string };
  };

function maxTokens(
  options: Record<string, unknown>,
  stage: "grouping" | "translation",
  unitCount: number,
): number {
  const body = buildSemanticStageRequestBody(options, [], {}, stage, unitCount);
  return Number(body.max_tokens ?? body.max_output_tokens);
}

const messages = [
  { role: "system", content: [{ type: "text", text: "System" }] },
  {
    role: "user",
    content: [
      { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
      { type: "text", text: "Translate" },
    ],
  },
];
const responseFormat = {
  type: "json_object",
  schema: {
    type: "object",
    properties: { items: { type: "array", items: { type: "string" } } },
    required: ["items"],
    additionalProperties: false,
  },
};

describe("semantic OCR structured output budgets", () => {
  it("uses standard OpenAI-compatible JSON Schema without llama-only fields", () => {
    const body = buildSemanticStageRequestBody(
      {
        modelProvider: "openai-api",
        apiModel: "gemini-3.5-flash-lite",
        maxTokens: 65_536,
        apiTemperature: 0.2,
        apiTopP: 0.95,
      },
      messages,
      responseFormat,
      "translation",
      3,
    );

    expect(body).toMatchObject({
      model: "gemini-3.5-flash-lite",
      messages,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "manga_translation",
          strict: true,
          schema: responseFormat.schema,
        },
      },
    });
    for (const key of [
      "schema",
      "chat_template_kwargs",
      "reasoning_format",
      "reasoning_budget",
      "enable_thinking",
      "top_k",
      "seed",
      "cache_prompt",
      "repeat_penalty",
      "repeat_last_n",
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("constrains Google requests and schemas to its OpenAI compatibility contract", () => {
    const body = buildSemanticStageRequestBody(
      {
        modelProvider: "openai-api",
        apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiModel: "gemini-3.5-flash-lite",
        apiTopK: 64,
        apiExtraBodyJson: JSON.stringify({
          seed: 424242,
          repeat_penalty: 1.08,
          chat_template_kwargs: { enable_thinking: false },
        }),
        maxTokens: 65_536,
      },
      messages,
      {
        type: "json_object",
        schema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              minLength: 1,
              pattern: "^[^\\n]+$",
            },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
      "translation",
      1,
    );

    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "manga_translation",
        strict: true,
        schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    });
    for (const key of [
      "top_k",
      "seed",
      "repeat_penalty",
      "chat_template_kwargs",
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("uses JSON mode for Google translations that collect nested page context", () => {
    const body = buildSemanticStageRequestBody(
      {
        modelProvider: "openai-api",
        apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiModel: "gemini-3.5-flash-lite",
        collectPageContext: true,
        maxTokens: 65_536,
      },
      messages,
      responseFormat,
      "translation",
      3,
    );

    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("keeps Ollama OpenAI requests within its documented sampling fields", () => {
    const body = buildSemanticStageRequestBody(
      {
        modelProvider: "openai-api",
        apiBaseUrl: "http://192.168.1.5:11434/v1",
        apiModel: "gemma4:latest",
        apiTopK: 64,
        apiExtraBodyJson: JSON.stringify({ top_k: 32 }),
        maxTokens: 65_536,
      },
      messages,
      responseFormat,
      "translation",
      1,
    );

    expect(body).not.toHaveProperty("top_k");
    expect(body.response_format).toMatchObject({ type: "json_schema" });
  });

  it.each(["gemma4:31b-cloud", "glm-5.3-flash:cloud"])(
    "uses Ollama Cloud JSON mode instead of unsupported structured outputs for %s",
    (apiModel) => {
      for (const stage of ["grouping", "translation"] as const) {
        const body = buildSemanticStageRequestBody(
          {
            modelProvider: "openai-api",
            apiBaseUrl: "http://localhost:11434/v1",
            apiModel,
            maxTokens: 65_536,
          },
          messages,
          responseFormat,
          stage,
          2,
        );

        expect(body.response_format).toEqual({ type: "json_object" });
      }
    },
  );

  it("keeps llama.cpp's native structured-output and sampling contract", () => {
    const body = buildSemanticStageRequestBody(
      { modelProvider: "gemma", maxTokens: 24_576, temperature: 0.2 },
      messages,
      responseFormat,
      "translation",
      3,
    );

    expect(body).toMatchObject({
      response_format: responseFormat,
      chat_template_kwargs: { enable_thinking: false },
      reasoning_format: "none",
      reasoning_budget: 0,
      enable_thinking: false,
      top_k: 64,
      seed: 424_242,
      cache_prompt: false,
      repeat_penalty: 1.08,
      repeat_last_n: 256,
    });
  });

  it("uses the Codex Responses schema contract", () => {
    const body = buildSemanticStageRequestBody(
      {
        modelProvider: "openai-codex",
        codexModel: "gpt-5.6-sol",
        codexReasoningEffort: "high",
        maxTokens: 32_768,
      },
      messages,
      responseFormat,
      "grouping",
      3,
    );

    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      instructions: "System",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,AA==",
              detail: "original",
            },
            { type: "input_text", text: "Translate" },
          ],
        },
      ],
      reasoning: { effort: "high" },
      text: {
        format: {
          type: "json_schema",
          name: "manga_grouping",
          strict: true,
          schema: responseFormat.schema,
        },
      },
      stream: true,
      store: false,
    });
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("response_format");
  });

  it("keeps the compact grouping budget", () => {
    expect(maxTokens({ maxTokens: 32_768 }, "grouping", 5)).toBe(512);
  });

  it("reserves a generous first-pass translation and page-context budget", () => {
    expect(
      maxTokens(
        {
          maxTokens: 32_768,
          collectPageContext: true,
          translationAttempt: 1,
          workContextBudget: {
            effective: { outputHeadroomTokens: 40_000 },
          },
        },
        "translation",
        5,
      ),
    ).toBe(17_408);
    expect(
      maxTokens(
        {
          maxTokens: 32_768,
          collectPageContext: false,
          translationAttempt: 1,
        },
        "translation",
        5,
      ),
    ).toBe(9_216);
  });

  it("doubles retries without exceeding configured or actual headroom", () => {
    expect(
      maxTokens(
        {
          maxTokens: 32_768,
          collectPageContext: true,
          translationAttempt: 2,
          workContextBudget: {
            effective: { outputHeadroomTokens: 40_000 },
          },
        },
        "translation",
        5,
      ),
    ).toBe(32_768);
    expect(
      maxTokens(
        {
          maxTokens: 32_768,
          collectPageContext: true,
          translationAttempt: 2,
          workContextBudget: {
            effective: { outputHeadroomTokens: 12_000 },
          },
        },
        "translation",
        5,
      ),
    ).toBe(12_000);
  });

  it("uses the configured context window when no work-context snapshot exists", () => {
    expect(
      maxTokens(
        {
          maxTokens: 32_768,
          ctx: 16_384,
          collectPageContext: true,
          translationAttempt: 1,
        },
        "translation",
        3,
      ),
    ).toBe(9_984);
  });

  it("distinguishes configured output, work-context, and local context caps", () => {
    expect(
      resolveStructuredTokenBudget(
        { maxTokens: 4096, ctx: 32_768, modelProvider: "openai-api" },
        "translation",
        5,
      ).source,
    ).toBe("max-output-tokens");
    expect(
      resolveStructuredTokenBudget(
        {
          maxTokens: 32_768,
          modelProvider: "openai-api",
          translationAttempt: 2,
          workContextBudget: {
            effective: { outputHeadroomTokens: 12_000 },
          },
        },
        "translation",
        5,
      ).source,
    ).toBe("work-context-budget");
    expect(
      resolveStructuredTokenBudget(
        {
          maxTokens: 32_768,
          modelProvider: "gemma",
          translationAttempt: 2,
          workContextBudget: {
            effective: { outputHeadroomTokens: 12_000 },
          },
        },
        "translation",
        5,
      ).source,
    ).toBe("context-length");
    expect(
      resolveStructuredTokenBudget(
        { maxTokens: 32_768, ctx: 65_536, modelProvider: "openai-api" },
        "translation",
        1,
      ).source,
    ).toBe("structured-request-budget");
  });
});
