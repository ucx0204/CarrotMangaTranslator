import { describe, expect, it } from "vitest";
import { extractPageContextResponse } from "../src/main/pipeline/pageContextResponse";

describe("page context response parsing", () => {
  it("strips and parses a valid tagged context trailer", () => {
    const output = [
      "id: 1",
      "jp: 勇者",
      "ko: 용사",
      "",
      "<page-context>",
      JSON.stringify({
        visualSummary: "용사가 성문 앞에 선다.",
        glossary: [
          {
            source: "勇者",
            target: "용사",
            category: "term",
            aliases: [],
          },
        ],
        characters: [],
      }),
      "</page-context>",
    ].join("\n");

    const parsed = extractPageContextResponse(output);

    expect(parsed.status).toBe("parsed");
    expect(parsed.overlayText).toContain("jp: 勇者");
    expect(parsed.overlayText).not.toContain("page-context");
    expect(parsed.pageContext).toMatchObject({
      visualSummary: "용사가 성문 앞에 선다.",
      glossary: [{ source: "勇者", target: "용사" }],
      characters: [],
    });
  });

  it("removes malformed and unterminated trailers without throwing", () => {
    const parsed = extractPageContextResponse(
      'id: 1\njp: 勇者\nko: 용사\n<page-context>{"visualSummary":',
    );

    expect(parsed).toEqual({
      overlayText: "id: 1\njp: 勇者\nko: 용사",
      status: "invalid",
    });
  });

  it("rejects schema-broken text fields instead of stringifying objects", () => {
    const parsed = extractPageContextResponse(
      '<page-context>{"visualSummary":{"text":"장면"},"glossary":[],"characters":[]}</page-context>',
    );

    expect(parsed).toEqual({ overlayText: "", status: "invalid" });
  });

  it("leaves legacy translation output unchanged when context is missing", () => {
    const output = '{"items":[]}';
    expect(extractPageContextResponse(output)).toEqual({
      overlayText: output,
      status: "missing",
    });
  });
});
