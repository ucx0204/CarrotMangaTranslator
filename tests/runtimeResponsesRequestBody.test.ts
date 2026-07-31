import { describe, expect, it } from "vitest";
import {
  buildResponsesRequestBody,
  buildChatRequestBody,
  buildChatRequestHeaders,
  buildHttpFailureMessage,
  extractModelOutputFailure,
  extractModelOutputText,
  inspectModelLaunch,
  isModelCached,
  parseResponsesSseText,
} from "./helpers/runtimeModelContracts";

describe("runtime Responses request body contracts", () => {
  it("treats OpenAI Codex as a remote OAuth-backed endpoint", () => {
    const launch = inspectModelLaunch({
      modelProvider: "openai-codex",
      codexModel: "gpt-5.6-luna",
      codexReasoningEffort: "max",
    });

    expect(launch).toEqual({
      launchMode: "openai-codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      requiresDownload: false,
    });
    expect(isModelCached({ modelProvider: "openai-codex" })).toBe(true);
  });

  it("treats OpenAI-compatible API as a direct remote endpoint", () => {
    const launch = inspectModelLaunch({
      modelProvider: "openai-api",
      apiBaseUrl: "http://127.0.0.1:1234/v1",
      apiModel: "local-vision-model",
    });

    expect(launch).toEqual({
      launchMode: "openai-api",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-vision-model",
      requiresDownload: false,
    });
    expect(isModelCached({ modelProvider: "openai-api" })).toBe(true);
  });

  it("builds API chat requests without Gemma-only fields", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ];
    const requestBody = buildChatRequestBody(
      {
        modelProvider: "openai-api",
        apiModel: "local-vision-model",
        temperature: 0.2,
        topP: 0.95,
        topK: 64,
      },
      messages,
      256,
    );

    expect(requestBody).toMatchObject({
      model: "local-vision-model",
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 256,
      messages,
    });
    expect(requestBody).not.toHaveProperty("top_k");
    expect(requestBody).not.toHaveProperty("reasoning_budget");
    expect(requestBody).not.toHaveProperty("enable_thinking");
  });

  it("omits nullable API fields and merges extra request body without overriding locked fields", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ];
    const requestBody = buildChatRequestBody(
      {
        modelProvider: "openai-api",
        apiModel: "locked-model",
        apiTemperature: null,
        apiTopP: null,
        apiTopK: 7,
        apiReasoningEffort: "minimal",
        apiExtraBodyJson:
          '{"model":"wrong","messages":[],"max_tokens":999,"top_k":1,"provider":{"sort":"throughput"}}',
      },
      messages,
      256,
    );

    expect(requestBody).toMatchObject({
      model: "locked-model",
      messages,
      max_tokens: 256,
      top_k: 1,
      reasoning_effort: "minimal",
      provider: { sort: "throughput" },
    });
    expect(requestBody).not.toHaveProperty("temperature");
    expect(requestBody).not.toHaveProperty("top_p");
  });

  it("throws readable errors for invalid API extra body JSON", () => {
    expect(() =>
      buildChatRequestBody(
        {
          modelProvider: "openai-api",
          apiExtraBodyJson: "[]",
        },
        [{ role: "user", content: [] }],
        256,
      ),
    ).toThrow(/API extra request body JSON은 JSON 객체/);
  });

  it("adds API authorization headers only when a key is configured", () => {
    const originalApiKey = process.env.MANGA_TRANSLATOR_API_KEY;
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.MANGA_TRANSLATOR_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      expect(
        buildChatRequestHeaders({
          modelProvider: "openai-api",
          apiKey: "",
        }),
      ).toEqual({ "Content-Type": "application/json" });
      expect(
        buildChatRequestHeaders({
          modelProvider: "openai-api",
          apiKey: "sk-test",
        }),
      ).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer sk-test",
      });
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.MANGA_TRANSLATOR_API_KEY;
      } else {
        process.env.MANGA_TRANSLATOR_API_KEY = originalApiKey;
      }
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
    }
  });

  it("adds custom API headers without allowing protected header overrides", () => {
    expect(
      buildChatRequestHeaders({
        modelProvider: "openai-api",
        apiKey: "sk-test",
        apiCustomHeadersJson:
          '{"HTTP-Referer":"https://example.invalid","X-Flag":true}',
      }),
    ).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
      "HTTP-Referer": "https://example.invalid",
      "X-Flag": "true",
    });

    expect(() =>
      buildChatRequestHeaders({
        modelProvider: "openai-api",
        apiCustomHeadersJson: '{"Authorization":"Bearer nope"}',
      }),
    ).toThrow(/덮어쓸 수 없습니다/);
    expect(() =>
      buildChatRequestHeaders({
        modelProvider: "openai-api",
        apiCustomHeadersJson: '{"X-Bad":{"nested":true}}',
      }),
    ).toThrow(/문자열, 숫자, boolean/);
  });

  it("uses OPENAI_API_KEY only for the official OpenAI API endpoint", () => {
    const originalApiKey = process.env.MANGA_TRANSLATOR_API_KEY;
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.MANGA_TRANSLATOR_API_KEY;
    process.env.OPENAI_API_KEY = "openai-env-key";

    try {
      expect(
        buildChatRequestHeaders({
          modelProvider: "openai-api",
          apiBaseUrl: "https://api.openai.com/v1",
        }),
      ).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer openai-env-key",
      });
      expect(
        buildChatRequestHeaders({
          modelProvider: "openai-api",
          apiBaseUrl: "https://integrate.api.nvidia.com/v1",
        }),
      ).toEqual({ "Content-Type": "application/json" });
      expect(
        buildChatRequestHeaders({
          modelProvider: "openai-api",
          apiBaseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: "saved-provider-key",
        }),
      ).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer saved-provider-key",
      });

      process.env.MANGA_TRANSLATOR_API_KEY = "provider-env-key";
      expect(
        buildChatRequestHeaders({
          modelProvider: "openai-api",
          apiBaseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: "saved-provider-key",
        }),
      ).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer provider-env-key",
      });
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.MANGA_TRANSLATOR_API_KEY;
      } else {
        process.env.MANGA_TRANSLATOR_API_KEY = originalApiKey;
      }
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
    }
  });

  it("describes API HTTP failures with status and setup hints", () => {
    expect(
      buildHttpFailureMessage(
        { modelProvider: "openai-api" },
        401,
        "Unauthorized",
      ),
    ).toContain("API 오류 401 Unauthorized: 인증에 실패했습니다.");
    expect(
      buildHttpFailureMessage(
        { modelProvider: "openai-api" },
        400,
        "Bad Request",
      ),
    ).toContain("선택한 모델이 이미지 입력을 지원하는지");
  });

  it("builds Codex Responses requests with input_image data URLs", () => {
    const requestBody = buildResponsesRequestBody(
      {
        modelProvider: "openai-codex",
        codexModel: "gpt-5.6-sol",
        codexReasoningEffort: "ultra",
        imageWidth: 836,
        imageHeight: 1188,
      },
      [
        {
          role: "openai-vision",
          dataUrl: "data:image/png;base64,abc123",
          width: 836,
          height: 1188,
          originalWidth: 836,
          originalHeight: 1188,
        },
      ],
    );

    expect(requestBody.model).toBe("gpt-5.6-sol");
    expect(requestBody.reasoning.effort).toBe("ultra");
    expect(requestBody.stream).toBe(true);
    expect(requestBody.store).toBe(false);
    expect(
      requestBody.input[0]?.content.some(
        (part) =>
          part.type === "input_image" &&
          part.image_url === "data:image/png;base64,abc123" &&
          part.detail === "original",
      ),
    ).toBe(true);
    expect(requestBody.input[0]?.content[0]).toMatchObject({
      type: "input_image",
      image_url: "data:image/png;base64,abc123",
    });
    expect(requestBody.input[0]?.content[1]).toMatchObject({
      type: "input_text",
    });
    expect(requestBody).not.toHaveProperty("max_tokens");
  });

  it("uses tight Japanese glyph bbox instructions for Codex Responses requests", () => {
    const requestBody = buildResponsesRequestBody(
      {
        modelProvider: "openai-codex",
        codexModel: "gpt-5.5",
        codexReasoningEffort: "medium",
        imageWidth: 7680,
        imageHeight: 4320,
      },
      [
        {
          role: "openai-vision",
          dataUrl: "data:image/png;base64,abc123",
          width: 4256,
          height: 2400,
          originalWidth: 7680,
          originalHeight: 4320,
        },
      ],
    );
    const promptText =
      requestBody.input[0]?.content.find(
        (part) => part.type === "input_text" && part.text?.includes("# Task"),
      )?.text ?? "";
    const imageDescription =
      requestBody.input[0]?.content.find(
        (part) => part.type === "input_text" && part.text?.includes("Image 1:"),
      )?.text ?? "";

    expect(requestBody.instructions).toContain(
      "Geometry accuracy comes before Korean text fit",
    );
    expect(requestBody.instructions).toContain(
      "Never merge separate speech bubbles, including touching or stacked balloon lobes.",
    );
    expect(promptText).toContain("Detect every visible Japanese text group");
    expect(promptText).toContain(
      "You are given one full-page Japanese manga image.",
    );
    expect(promptText).toContain(
      "fontSize is the apparent Japanese glyph size in Image 1 pixels",
    );
    expect(promptText).toContain(
      "x1, y1, x2, y2 describe the tight rectangle corners of the visible Japanese glyph ink and its outline.",
    );
    expect(promptText).toContain("Each speech bubble is one dialogue item.");
    expect(promptText).toContain(
      "If two white balloon lobes touch, overlap, stack vertically, or connect through a narrow neck",
    );
    expect(promptText).toContain(
      "Never enlarge, shift, or reshape the rectangle",
    );
    expect(promptText).toContain("The original page is 7680x4320 px.");
    expect(promptText).toContain(
      "Image 1 was prepared before the API call to match the OpenAI detail: original vision frame",
    );
    expect(promptText).toContain(
      "Return x1, y1, x2, y2 as integer pixel coordinates in that 4256x2400 Image 1 frame.",
    );
    expect(
      requestBody.input[0]?.content.find(
        (part) => part.type === "input_text" && part.text?.includes("# Task"),
      )?.text,
    ).not.toContain("Return x, y, w, h as normalized 0..1000");
    expect(imageDescription).toContain(
      "prepared for OpenAI detail: original vision",
    );
    expect(promptText).toContain(
      "Do not return width/height, original-page pixels, normalized 0..1000 coordinates, viewport coordinates, crop coordinates, tile coordinates, or model-internal coordinates.",
    );
  });

  it("extracts text from Responses API output payloads", () => {
    expect(
      extractModelOutputText({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "id: 1\nko: 테스트",
              },
            ],
          },
        ],
      }),
    ).toBe("id: 1\nko: 테스트");
  });

  it("classifies reasoning-only chat responses without using thoughts as output", () => {
    const parsed = {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: null,
            reasoning_content: "internal thoughts",
          },
        },
      ],
    };

    expect(extractModelOutputText(parsed)).toBe("");
    expect(extractModelOutputFailure(parsed)).toMatchObject({
      failureCategory: "empty-model-response",
      nonRetriable: true,
    });
  });

  it("classifies a partial nonempty chat response stopped by max_tokens", () => {
    expect(
      extractModelOutputFailure({
        choices: [
          {
            finish_reason: "length",
            message: { content: '{"items":[' },
          },
        ],
      }),
    ).toMatchObject({
      failureCategory: "empty-model-response",
      outputTruncated: true,
    });
  });

  it("classifies a partial nonempty Responses result stopped by max_output_tokens", () => {
    expect(
      extractModelOutputFailure({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: '{"items":[' }],
          },
        ],
      }),
    ).toMatchObject({
      failureCategory: "empty-model-response",
      outputTruncated: true,
    });
  });

  it("classifies a raw response.incomplete SSE event", () => {
    expect(
      extractModelOutputFailure({
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      }),
    ).toMatchObject({
      failureCategory: "empty-model-response",
      outputTruncated: true,
    });
  });

  it("does not classify final content plus provider reasoning as reasoning-only", () => {
    expect(
      extractModelOutputFailure({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: '{"items":[]}',
              reasoning_content: "internal thoughts",
            },
          },
        ],
      }),
    ).toBeNull();
  });

  it("collects Responses API streaming text deltas", () => {
    const parsed = parseResponsesSseText(
      [
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"id: 1"}',
        "",
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"\\nko: 테스트"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"id":"resp_1","output":[]}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
    );

    expect(parsed.outputText).toBe("id: 1\nko: 테스트");
    expect(parsed.eventCount).toBe(3);
  });
});
