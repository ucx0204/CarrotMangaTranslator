import { describe, expect, it } from "vitest";
import {
  buildResponsesRequestBody,
  extractModelOutputText,
  inspectModelLaunch,
  isModelCached,
  parseResponsesSseText,
} from "./helpers/runtimeModelContracts";

describe("runtime Responses request body contracts", () => {
  it("treats OpenAI Codex as a remote OAuth-backed endpoint", () => {
    const launch = inspectModelLaunch({
      modelProvider: "openai-codex",
      codexModel: "gpt-5.5",
      codexReasoningEffort: "high",
    });

    expect(launch).toEqual({
      launchMode: "openai-codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
      requiresDownload: false,
    });
    expect(isModelCached({ modelProvider: "openai-codex" })).toBe(true);
  });

  it("builds Codex Responses requests with input_image data URLs", () => {
    const requestBody = buildResponsesRequestBody(
      {
        modelProvider: "openai-codex",
        codexModel: "gpt-5.5",
        codexReasoningEffort: "xhigh",
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

    expect(requestBody.model).toBe("gpt-5.5");
    expect(requestBody.reasoning.effort).toBe("xhigh");
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
