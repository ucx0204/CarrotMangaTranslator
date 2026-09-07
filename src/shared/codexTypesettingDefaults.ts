import { BUILT_IN_BLOCK_FONTS } from "./blockFontCatalog";
import type {
  CodexTypesettingOptions,
  CodexTypesettingPreferences,
} from "./codexTypesettingTypes";

export const CODEX_TYPESETTING_MODEL = "gpt-6-astra";

export function createCodexTypesettingPreferences(
  targetLanguage: string,
): CodexTypesettingPreferences {
  const preferredIds = [
    "mongtori",
    "nanum-gothic",
    "nanum-myeongjo",
    "chosun-gungseo",
  ];
  const candidates = BUILT_IN_BLOCK_FONTS.filter(
    (font) => font.locale === targetLanguage,
  );
  const fonts =
    targetLanguage === "ko"
      ? candidates.filter((font) => preferredIds.includes(font.id))
      : candidates.slice(0, 4);
  return {
    enabled: false,
    sfxRendering: "image",
    selectedPresetId: "default",
    presets: [
      {
        id: "default",
        name: targetLanguage === "ko" ? "기본 서체" : "Default",
        fonts: (fonts.length ? fonts : BUILT_IN_BLOCK_FONTS.slice(0, 4)).map(
          (font) => ({
            fontId: font.id,
            purpose: defaultFontPurpose(font.id),
          }),
        ),
      },
    ],
  };
}

function defaultFontPurpose(id: string): string {
  const purposes: Record<string, string> = {
    mongtori:
      "부드럽고 가벼운 손글씨 계열. 원문이 같은 계열이면 작은 덧말과 큰 감정 표현도 같은 폰트를 유지하고 크기·굵기로 구분.",
    "nanum-gothic":
      "단정한 고딕 대사 계열. 일반 대사의 중립적인 기준. 원문의 서체 계열을 우선하고 굵은 강조도 같은 계열 안에서 처리.",
    "nanum-myeongjo":
      "명조·세리프 계열의 차분한 서술과 격식 있는 표현. 내레이션이라는 이유만으로 강제하지 말고 원문의 획 모양을 우선.",
    "chosun-gungseo":
      "붓의 강약이 있는 손글씨와 극적인 효과음 계열. 실제 견본의 굵기 차이를 확인하고, 글자 변형만으로 자연스럽지 않으면 이미지 전경 사용.",
  };
  return (
    purposes[id] ??
    "Match the visible source font family. Keep that family consistent across the chapter; vary size, weight and effects when supported by the source."
  );
}

export function resolveCodexTypesettingOptions(
  saved: CodexTypesettingPreferences | undefined,
  targetLanguage: string,
): CodexTypesettingOptions {
  const preferences =
    saved ?? createCodexTypesettingPreferences(targetLanguage);
  const preset =
    preferences.presets.find(
      (item) => item.id === preferences.selectedPresetId,
    ) ?? preferences.presets[0];
  return {
    version: 1,
    preset,
    sfxRendering: preferences.sfxRendering,
    eraseOriginal: preferences.eraseOriginal !== false,
  };
}
