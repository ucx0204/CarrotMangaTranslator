import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type { UiLocale } from "../../shared/uiLocales";
import {
  countFontCandidateCodePointsInRange,
  fontCandidateCoversRange,
  fontCandidateSupportsText,
} from "../fontCoverage";

const BODY_COMMON_PUNCTUATION = ".,!?;:'\"()[]{}+-/%—…";
const BODY_LOCALE_PUNCTUATION: Readonly<Record<UiLocale, string>> = {
  ko: "·“”‘’",
  en: "“”‘’",
  ja: "、。！？「」『』（）・ー",
  "zh-Hans": "，。！？“”‘’（）《》、",
  "zh-Hant": "，。！？「」『』（）《》、",
};

export function fontCandidateSupportsBodyLocale(
  candidate: Pick<AutomaticFontCandidate, "supportedLocales" | "unicodeRanges">,
  locale: UiLocale,
): boolean {
  if (
    !candidate.supportedLocales.includes(locale) ||
    !fontCandidateSupportsText(
      candidate,
      BODY_COMMON_PUNCTUATION + BODY_LOCALE_PUNCTUATION[locale],
    )
  ) {
    return false;
  }
  if (locale === "ko") {
    return (
      fontCandidateCoversRange(candidate, 0xac00, 0xd7a3) &&
      fontCandidateCoversRange(candidate, 0x21, 0x7e)
    );
  }
  if (locale === "en") {
    return fontCandidateCoversRange(candidate, 0x21, 0x7e);
  }
  if (locale === "ja") {
    return (
      countFontCandidateCodePointsInRange(candidate, 0x3041, 0x3096) >= 80 &&
      countFontCandidateCodePointsInRange(candidate, 0x30a1, 0x30fa) >= 85 &&
      countFontCandidateCodePointsInRange(candidate, 0x4e00, 0x9fff) >= 6000
    );
  }
  return countFontCandidateCodePointsInRange(candidate, 0x4e00, 0x9fff) >= 6000;
}
