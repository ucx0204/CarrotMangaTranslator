import { expect, it } from "vitest";
import { translateMcpBlock } from "../src/main/mcp/mcpBlockTranslationAdapter";
import { translationFixture as fixture } from "./mcpBlockTranslation.fixture";

it.each(["none", "saved"] as const)(
  "reserves the requested output budget in %s mode before starting a provider",
  async (contextMode) => {
    const f = await fixture();
    try {
      const before = await f.snapshot();
      await expect(
        translateMcpBlock(
          { ...f.input, contextMode },
          { ...f.options, ctx: 2048, maxTokens: 4096 },
          f.operation,
          f.runtime,
        ),
      ).rejects.toMatchObject({ code: "invalid_edit" });
      expect(f.runtime.start).not.toHaveBeenCalled();
      expect(f.runtime.request).not.toHaveBeenCalled();
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await f.close();
    }
  },
);

it("does not let contextMode none bypass the source input budget", async () => {
  const f = await fixture();
  try {
    await expect(
      translateMcpBlock(
        { ...f.input, contextMode: "none", sourceText: "原文".repeat(10000) },
        { ...f.options, ctx: 4096, maxTokens: 1024 },
        f.operation,
        f.runtime,
      ),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    expect(f.runtime.start).not.toHaveBeenCalled();
    expect(f.runtime.request).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("accepts a bounded text-only proposal without saved context", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const result = await translateMcpBlock(
      { ...f.input, contextMode: "none" },
      f.options,
      f.operation,
      f.runtime,
    );
    expect(result.translatedText).toBe("translated\n\ud83e\udd55");
    expect(f.runtime.start).toHaveBeenCalledOnce();
    expect(f.runtime.request).toHaveBeenCalledOnce();
    expect(f.session.dispose).toHaveBeenCalledOnce();
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
  "rejects invalid configured limits (%s) instead of silently normalizing them",
  async (value) => {
    const f = await fixture();
    try {
      expect(() => f.prepare({ ...f.options, ctx: value })).toThrow();
      expect(() => f.prepare({ ...f.options, maxTokens: value })).toThrow();
      expect(f.runtime.start).not.toHaveBeenCalled();
      expect(f.runtime.request).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("rejects JSON numeric overflow in sampling options before any external request", async () => {
  const f = await fixture();
  try {
    expect(() =>
      f.prepare({ ...f.options, apiExtraBodyJson: '{"temperature":1e999}' }),
    ).toThrow();
    expect(f.runtime.request).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
