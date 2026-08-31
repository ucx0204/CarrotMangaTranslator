import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSLATION_LANGUAGE_SETTINGS,
  isValidLanguageCodeInput,
  KNOWN_TRANSLATION_LANGUAGES,
  normalizeLanguageCode,
  PRIMARY_TRANSLATION_LANGUAGE_CODES,
  resolveLanguage,
  resolveLanguagePair,
  resolveSourceReadingDirection,
  resolveTranslationLanguageSettings,
} from "../src/shared/translationLanguages";
import { filterPagesByOcrText } from "../src/main/pipeline/pageFiltering";
import type { MangaPage } from "../src/shared/libraryTypes";

const languageProfile =
  require("../src/main/runtime/simple-page-language-profile.cjs") as {
    allowOcrNoTextDetectedSkip: (options?: Record<string, unknown>) => boolean;
    resolvePromptLanguageProfile: (options?: Record<string, unknown>) => {
      sourceCode: string;
      targetCode: string;
      sourceName: string;
      targetName: string;
      sourceKey: string;
      targetKey: string;
      isDefaultJapaneseToKorean: boolean;
    };
  };
const ocrCommands =
  require("../src/main/runtime/simple-page-ocr-commands.cjs") as {
    buildOcrSourceLanguageArgs: (options?: Record<string, unknown>) => string[];
    buildOcrBboxCommand: (
      options?: Record<string, unknown>,
      provider?: string,
      outputPath?: string,
    ) => { executable: string; args: string[] };
  };
const ocrRuntimeConfig =
  require("../src/main/runtime/simple-page-ocr-runtime-config.cjs") as {
    buildOcrRuntimeEnv: (
      options?: Record<string, unknown>,
      runtime?: Record<string, unknown>,
    ) => NodeJS.ProcessEnv;
  };
const ocrHintsRuntime =
  require("../src/main/runtime/simple-page-ocr-hints.cjs") as {
    normalizeOcrBboxHintPayload: (
      payload: unknown,
      options?: Record<string, unknown>,
    ) => Array<{
      ocrText?: string;
      groupId?: string;
      orderInGroup?: number;
    }>;
  };

describe("translation language domain", () => {
  it("normalizes language code casing and rejects invalid codes", () => {
    expect(normalizeLanguageCode("JA", "ko")).toBe("ja");
    expect(normalizeLanguageCode("ZH-HANS", "ja")).toBe("zh-Hans");
    expect(normalizeLanguageCode("zh-hant", "ja")).toBe("zh-Hant");
    expect(normalizeLanguageCode("", "ja")).toBe("ja");
    expect(normalizeLanguageCode("not a code!", "ja")).toBe("ja");
    expect(normalizeLanguageCode(undefined, "ko")).toBe("ko");
  });

  it("keeps custom language codes instead of forcing presets", () => {
    expect(
      resolveTranslationLanguageSettings({
        sourceLanguage: "de",
        targetLanguage: "vi",
      }),
    ).toEqual({ sourceLanguage: "de", targetLanguage: "vi" });
    expect(resolveTranslationLanguageSettings(null)).toEqual(
      DEFAULT_TRANSLATION_LANGUAGE_SETTINGS,
    );
  });

  it("resolves display and prompt names for known and custom codes", () => {
    expect(resolveLanguage("ja")).toEqual({
      code: "ja",
      labelKo: "일본어",
      promptName: "Japanese",
    });
    expect(resolveLanguage("zh-Hant").promptName).toBe("Traditional Chinese");
    expect(resolveLanguage("zh-TW").promptName).toBe("Traditional Chinese");
    expect(resolveLanguage("zh-Hant-HK").promptName).toBe(
      "Traditional Chinese",
    );
    expect(resolveLanguage("ja-JP").promptName).toBe("Japanese");
    expect(resolveLanguage("en-US").promptName).toBe("English");
    expect(resolveLanguage("zh")).toEqual({
      code: "zh",
      labelKo: "중국어 간체",
      promptName: "Simplified Chinese",
    });
    expect(resolveLanguage("zh-Latn-HK").promptName).toBe(
      "Traditional Chinese",
    );
    expect(resolveLanguage("xx").promptName).toBe("XX");
  });

  it("validates custom language code input", () => {
    const overlongCode = "en-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-cc-dd";
    expect(isValidLanguageCodeInput("eo")).toBe(true);
    expect(isValidLanguageCodeInput("PT-BR")).toBe(true);
    expect(isValidLanguageCodeInput("zh-Hant")).toBe(true);
    expect(isValidLanguageCodeInput("")).toBe(false);
    expect(isValidLanguageCodeInput("x")).toBe(false);
    expect(isValidLanguageCodeInput("not a code!")).toBe(false);
    expect(isValidLanguageCodeInput(overlongCode)).toBe(false);
    expect(normalizeLanguageCode(overlongCode, "ja")).toBe("ja");
  });

  it("exposes every primary language as a known preset", () => {
    for (const code of PRIMARY_TRANSLATION_LANGUAGE_CODES) {
      expect(
        KNOWN_TRANSLATION_LANGUAGES.some((language) => language.code === code),
      ).toBe(true);
    }
    // 프리셋 코드는 모두 정규화를 통과해야 한다.
    for (const language of KNOWN_TRANSLATION_LANGUAGES) {
      expect(normalizeLanguageCode(language.code, "invalid")).toBe(
        language.code,
      );
    }
  });

  it("marks only ja -> ko as the default Japanese to Korean pair", () => {
    expect(resolveLanguagePair(null).isDefaultJapaneseToKorean).toBe(true);
    expect(
      resolveLanguagePair({ sourceLanguage: "ja", targetLanguage: "ko" })
        .isDefaultJapaneseToKorean,
    ).toBe(true);
    expect(
      resolveLanguagePair({ sourceLanguage: "ja", targetLanguage: "en" })
        .isDefaultJapaneseToKorean,
    ).toBe(false);
    expect(
      resolveLanguagePair({ sourceLanguage: "ja-JP", targetLanguage: "ko-KR" })
        .isDefaultJapaneseToKorean,
    ).toBe(true);
  });

  it("resolves source reading direction from base language codes", () => {
    expect(resolveSourceReadingDirection("ja-JP")).toBe("rtl");
    expect(resolveSourceReadingDirection("ar-SA")).toBe("rtl");
    expect(resolveSourceReadingDirection("en-US")).toBe("ltr");
  });
});

describe("runtime prompt language profile", () => {
  it("uses jp/ko record keys only for the default pair", () => {
    const defaultProfile = languageProfile.resolvePromptLanguageProfile({});
    expect(defaultProfile.isDefaultJapaneseToKorean).toBe(true);
    expect(defaultProfile.sourceKey).toBe("jp");
    expect(defaultProfile.targetKey).toBe("ko");

    const generic = languageProfile.resolvePromptLanguageProfile({
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(generic.sourceKey).toBe("source");
    expect(generic.targetKey).toBe("target");
    expect(generic.sourceName).toBe("English");
    expect(generic.targetName).toBe("Simplified Chinese");

    const localeTagged = languageProfile.resolvePromptLanguageProfile({
      sourceLanguage: "ja-JP",
      targetLanguage: "ko-KR",
    });
    expect(localeTagged.sourceName).toBe("Japanese");
    expect(localeTagged.targetName).toBe("Korean");
    expect(localeTagged.isDefaultJapaneseToKorean).toBe(true);

    const overlong = languageProfile.resolvePromptLanguageProfile({
      sourceLanguage: "en-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-cc-dd",
      targetLanguage: "fr",
    });
    expect(overlong.sourceCode).toBe("ja");
  });

  it("keeps the runtime prompt-name map in sync with the shared presets", () => {
    for (const language of KNOWN_TRANSLATION_LANGUAGES) {
      const profile = languageProfile.resolvePromptLanguageProfile({
        sourceLanguage: language.code,
        targetLanguage: "ko",
      });
      expect(`${language.code}:${profile.sourceName}`).toBe(
        `${language.code}:${language.promptName}`,
      );
    }
  });

  it("allows the OCR no-text skip only for Japanese source pages", () => {
    expect(languageProfile.allowOcrNoTextDetectedSkip({})).toBe(true);
    expect(
      languageProfile.allowOcrNoTextDetectedSkip({ sourceLanguage: "ja" }),
    ).toBe(true);
    expect(
      languageProfile.allowOcrNoTextDetectedSkip({ sourceLanguage: "ja-JP" }),
    ).toBe(true);
    expect(
      languageProfile.allowOcrNoTextDetectedSkip({ sourceLanguage: "en" }),
    ).toBe(false);
    expect(
      languageProfile.allowOcrNoTextDetectedSkip({ sourceLanguage: "zh-Hans" }),
    ).toBe(false);
  });
});

describe("OCR source language plumbing", () => {
  it("omits the --source-language argument for the default Japanese source", () => {
    expect(ocrCommands.buildOcrSourceLanguageArgs({})).toEqual([]);
    expect(
      ocrCommands.buildOcrSourceLanguageArgs({ sourceLanguage: "ja" }),
    ).toEqual([]);
    expect(
      ocrCommands.buildOcrSourceLanguageArgs({ sourceLanguage: "ja-JP" }),
    ).toEqual([]);
  });

  it("passes non-default source languages to the Python adapter", () => {
    expect(
      ocrCommands.buildOcrSourceLanguageArgs({ sourceLanguage: "en" }),
    ).toEqual(["--source-language", "en"]);
    expect(
      ocrCommands.buildOcrSourceLanguageArgs({ sourceLanguage: "zh-Hans" }),
    ).toEqual(["--source-language", "zh-Hans"]);
  });

  it("passes source language to external OCR templates and child env", () => {
    const command = ocrCommands.buildOcrBboxCommand(
      {
        imagePath: "C:/manga/page.png",
        sourceLanguage: "en-US",
        ocrBboxCommand: JSON.stringify({
          executable: "custom-ocr",
          args: [
            "--lang",
            "{sourceLanguage}",
            "--image",
            "{image}",
            "--output",
            "{output}",
          ],
        }),
      },
      "custom",
      "C:/out/result.json",
    );
    const env = ocrRuntimeConfig.buildOcrRuntimeEnv(
      {
        sourceLanguage: "ar-SA",
        ocrRuntimeDir: "C:/ocr-runtime",
        toolsDir: "C:/tools",
      },
      {
        runtimeDir: "C:/ocr-runtime",
        packageDir: "C:/ocr-runtime/packages",
      },
    );

    expect(command).toEqual({
      executable: "custom-ocr",
      args: [
        "--lang",
        "en-US",
        "--image",
        "C:/manga/page.png",
        "--output",
        "C:/out/result.json",
      ],
    });
    expect(env.MANGA_TRANSLATOR_OCR_SOURCE_LANGUAGE).toBe("ar-SA");
  });

  it("preserves non-Japanese OCR text before prompt construction", () => {
    const hints = ocrHintsRuntime.normalizeOcrBboxHintPayload(
      {
        items: [
          {
            label: "vertical_text",
            bbox: [10, 10, 80, 180],
            text: "AI 技术",
          },
          {
            label: "vertical_text",
            bbox: [85, 10, 150, 180],
            text: "OCR 测试",
          },
        ],
      },
      {
        imageWidth: 200,
        imageHeight: 200,
        sourceLanguage: "zh-Hans",
      },
    );

    expect(hints.map((hint) => hint.ocrText)).toEqual(["AI 技术", "OCR 测试"]);
    // 일본어 세로쓰기용 그룹/읽기 순서 휴리스틱은 중국어 원문에 적용하지 않는다.
    expect(hints.every((hint) => !hint.groupId && !hint.orderInGroup)).toBe(
      true,
    );
  });

  it("keeps OCR no-text pages in the translation queue when the skip is disallowed", () => {
    const page = {
      id: "page-1",
      name: "001.png",
      imagePath: "001.png",
      dataUrl: "data:image/png;base64,",
      width: 100,
      height: 100,
      blocks: [],
      analysisStatus: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies MangaPage;
    const hints = new Map([
      [
        "page-1",
        {
          hints: [],
          diagnostics: [],
          noTextDetected: true,
          textEvidenceCount: 0,
        },
      ],
    ]);

    const skipped = filterPagesByOcrText([page], hints, {
      allowNoTextSkip: true,
    });
    expect(skipped.pagesToTranslate).toHaveLength(0);
    expect(skipped.prepassNoTextPages).toHaveLength(1);

    const kept = filterPagesByOcrText([page], hints, {
      allowNoTextSkip: false,
    });
    expect(kept.pagesToTranslate).toHaveLength(1);
    expect(kept.prepassNoTextPages).toHaveLength(0);
  });
});
