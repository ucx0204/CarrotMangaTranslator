import { describe, expect, it } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/settings/appSettingsDefaults";
import { normalizeBlockFormatDefaults } from "../src/main/settings/blockFormatDefaultsNormalize";
import {
  applyFormatDefaultsToBlock,
  BLOCK_FORMAT_GROUPS,
  DEFAULT_BLOCK_FORMAT_DEFAULTS,
  pickBlockFormat,
} from "../src/shared/blockFormat";
import { TranslationBlockSchema } from "../src/shared/ipcSchemaPrimitives";
import { AppSettingsSchema } from "../src/shared/ipcSettingsSchemas";
import type { AppSettings } from "../src/shared/settingsTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  DEFAULT_TEXT_WORD_BREAK,
  resolveBlockTextWordBreak,
  resolveTextWordBreak,
  TEXT_WORD_BREAK_VALUES,
} from "../src/shared/textWrapping";

describe("text wrapping settings", () => {
  it("resolves every supported value and falls back to the app default", () => {
    expect(TEXT_WORD_BREAK_VALUES).toEqual([
      "normal",
      "break-all",
      "keep-all",
      "break-word",
    ]);
    for (const value of TEXT_WORD_BREAK_VALUES) {
      expect(resolveTextWordBreak(value)).toBe(value);
    }
    expect(DEFAULT_TEXT_WORD_BREAK).toBe("break-word");
    expect(resolveTextWordBreak(undefined)).toBe("break-word");
    expect(resolveTextWordBreak("invalid")).toBe("break-word");
    expect(resolveTextWordBreak(null, "keep-all")).toBe("keep-all");
  });

  it("preserves direction-specific wrapping for legacy blocks", () => {
    expect(resolveBlockTextWordBreak(undefined, "horizontal")).toBe(
      "break-all",
    );
    expect(resolveBlockTextWordBreak(undefined, "vertical")).toBe("break-word");
    expect(resolveBlockTextWordBreak("normal", "horizontal")).toBe("normal");
    expect(resolveBlockTextWordBreak("keep-all", "vertical")).toBe("keep-all");
  });

  it("keeps legacy blocks valid while accepting only supported values", () => {
    const block = makeBlock();
    expect(TranslationBlockSchema.safeParse(block).success).toBe(true);
    for (const wordBreak of TEXT_WORD_BREAK_VALUES) {
      expect(
        TranslationBlockSchema.safeParse({ ...block, wordBreak }).success,
      ).toBe(true);
    }
    expect(
      TranslationBlockSchema.safeParse({ ...block, wordBreak: "invalid" })
        .success,
    ).toBe(false);
  });

  it("requires a supported wrapping default in settings IPC", () => {
    const settings = resolveDefaultAppSettings({}, null);
    expect(settings.blockFormatDefaults?.wordBreak).toBe("break-word");
    expect(AppSettingsSchema.safeParse(settings).success).toBe(true);

    const blockFormatDefaults = settings.blockFormatDefaults;
    if (!blockFormatDefaults) {
      throw new Error("expected default block formatting");
    }
    const { wordBreak: _wordBreak, ...legacyDefaults } = blockFormatDefaults;
    expect(
      AppSettingsSchema.safeParse({
        ...settings,
        blockFormatDefaults: legacyDefaults,
      }).success,
    ).toBe(false);
    expect(
      AppSettingsSchema.safeParse({
        ...settings,
        blockFormatDefaults: {
          ...blockFormatDefaults,
          wordBreak: "invalid",
        },
      }).success,
    ).toBe(false);
  });

  it("normalizes missing and invalid stored values to the configured base", () => {
    const defaults = {
      blockFormatDefaults: {
        ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
        wordBreak: "keep-all",
      },
    } as AppSettings;

    expect(normalizeBlockFormatDefaults({}, defaults).wordBreak).toBe(
      "keep-all",
    );
    expect(
      normalizeBlockFormatDefaults({ wordBreak: "invalid" }, defaults)
        .wordBreak,
    ).toBe("keep-all");
    expect(
      normalizeBlockFormatDefaults({ wordBreak: "break-all" }, defaults)
        .wordBreak,
    ).toBe("break-all");
  });

  it("applies and batch-copies wrapping as its own format group", () => {
    const defaults = {
      ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
      wordBreak: "break-word" as const,
    };
    const created = applyFormatDefaultsToBlock(makeBlock(), defaults);

    expect(created.wordBreak).toBe("break-word");
    expect(DEFAULT_BLOCK_FORMAT_DEFAULTS.wordBreak).toBe("break-word");
    expect(BLOCK_FORMAT_GROUPS).toContainEqual({
      id: "wordBreak",
      label: "줄바꿈",
      keys: ["wordBreak"],
    });
    expect(
      pickBlockFormat({ ...created, wordBreak: "break-all" }, ["wordBreak"]),
    ).toEqual({ wordBreak: "break-all" });
    expect(pickBlockFormat(makeBlock(), ["wordBreak"])).toEqual({
      wordBreak: "break-all",
    });
  });
});

function makeBlock(): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 10, y: 20, w: 200, h: 100 },
    sourceText: "원문",
    translatedText: "번역문",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}
