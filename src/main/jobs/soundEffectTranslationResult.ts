import type { MangaPage } from "../../shared/libraryTypes";
import type { SoundEffectReviewRegion } from "../../shared/soundEffectReview";
import type { TranslationBlock } from "../../shared/textTypes";
import { overlayItemToBlock } from "../pipeline/overlayItems";
import type { OverlayItem } from "../pipeline/types";
import { toReviewedSoundEffectBlock } from "./reviewedSoundEffectBlock";

type SoundEffectTranslationVerdict = "sound" | "reaction" | "uncertain";

export type ValidatedSoundEffectTranslation = {
  regionId: string;
  verdict: Exclude<SoundEffectTranslationVerdict, "uncertain">;
  confirmedSource: string;
  translation: string;
  confidence: number;
};

export type SoundEffectTranslationValidation = {
  valid: ValidatedSoundEffectTranslation[];
  retryRegionIds: string[];
  warnings: string[];
};

export type SoundEffectTranslationValidationOptions = {
  /** The second visual pass may overrule a genuinely incorrect OCR hint. */
  allowOcrMismatch?: boolean;
  /** The second visual pass may confirm a context-dependent Korean reading. */
  allowAmbiguousKoreanMeaning?: boolean;
};

export function validateSoundEffectTranslationResponse(
  payload: unknown,
  regions: readonly SoundEffectReviewRegion[],
  targetLanguage: string,
  options: SoundEffectTranslationValidationOptions = {},
): SoundEffectTranslationValidation {
  const expected = new Map(regions.map((region) => [region.id, region]));
  const seen = new Set<string>();
  const valid: ValidatedSoundEffectTranslation[] = [];
  const invalid = new Set<string>();
  const warnings: string[] = [];
  const items = readItems(payload);
  for (const raw of items) {
    const item = readItem(raw);
    if (!item || !expected.has(item.regionId)) {
      warnings.push("모델이 요청하지 않은 효과음 후보를 반환해 무시했습니다.");
      continue;
    }
    if (seen.has(item.regionId)) {
      invalid.add(item.regionId);
      warnings.push(`${item.regionId}: 중복 결과를 반환해 다시 시도합니다.`);
      continue;
    }
    seen.add(item.regionId);
    const region = expected.get(item.regionId);
    if (!region) continue;
    const reason = validateItem(item, region, targetLanguage, options);
    if (reason) {
      invalid.add(item.regionId);
      warnings.push(`${item.regionId}: ${reason}`);
      continue;
    }
    if (item.verdict === "uncertain") {
      invalid.add(item.regionId);
      warnings.push(`${item.regionId}: 모델이 검토 필요로 판정했습니다.`);
      continue;
    }
    appendOcrOverrideWarning(warnings, item, region, options);
    valid.push({ ...item, verdict: item.verdict });
  }
  for (const region of regions) {
    if (!seen.has(region.id)) {
      invalid.add(region.id);
      warnings.push(`${region.id}: 모델 응답에서 누락되어 다시 시도합니다.`);
    }
  }
  return {
    valid: valid.filter((item) => !invalid.has(item.regionId)),
    retryRegionIds: regions
      .map((region) => region.id)
      .filter((regionId) => invalid.has(regionId)),
    warnings,
  };
}

export function buildReviewedSoundEffectBlock(
  page: MangaPage,
  region: SoundEffectReviewRegion,
  translation: ValidatedSoundEffectTranslation,
  jobId: string,
  index: number,
): TranslationBlock {
  const item = buildReviewedSoundEffectOverlayItem(region, translation, index);
  return toReviewedSoundEffectBlock(
    overlayItemToBlock(item, page, index, `${jobId}-sfx`),
  );
}

export function buildReviewedSoundEffectOverlayItem(
  region: SoundEffectReviewRegion,
  translation: ValidatedSoundEffectTranslation,
  index: number,
): OverlayItem {
  return {
    id: index + 1,
    type: "nonsolid",
    textRole: "sound",
    bbox: region.bbox,
    jp: translation.confirmedSource,
    ko: translation.translation,
    sourceText: translation.confirmedSource,
    translatedText: translation.translation,
    direction: region.bbox.h > region.bbox.w * 1.5 ? "vertical" : "horizontal",
    angle: 0,
    confidence: translation.confidence,
  };
}

type ParsedItem = {
  regionId: string;
  verdict: SoundEffectTranslationVerdict;
  confirmedSource: string;
  translation: string;
  confidence: number;
};

function readItems(payload: unknown): unknown[] {
  return payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Array.isArray((payload as { items?: unknown }).items)
    ? ((payload as { items: unknown[] }).items ?? [])
    : [];
}

function readItem(value: unknown): ParsedItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "regionId",
    "verdict",
    "confirmedSource",
    "translation",
    "confidence",
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return null;
  const regionId = String(record.regionId ?? "").trim();
  const verdict = String(record.verdict ?? "").trim();
  const confirmedSource = String(record.confirmedSource ?? "").trim();
  const translation = String(record.translation ?? "").trim();
  const confidence = Number(record.confidence);
  if (
    !regionId ||
    !["sound", "reaction", "uncertain"].includes(verdict) ||
    !Number.isFinite(confidence)
  ) {
    return null;
  }
  return {
    regionId,
    verdict: verdict as SoundEffectTranslationVerdict,
    confirmedSource,
    translation,
    confidence,
  };
}

function validateItem(
  item: ParsedItem,
  region: SoundEffectReviewRegion,
  targetLanguage: string,
  options: SoundEffectTranslationValidationOptions,
): string | null {
  if (item.confidence < 0 || item.confidence > 1) {
    return "confidence가 0~1 범위를 벗어났습니다.";
  }
  if (item.verdict === "uncertain") {
    return item.translation ? "불확실 판정에 번역문이 포함됐습니다." : null;
  }
  const structuralReason = validateCertainItem(item, targetLanguage);
  if (structuralReason) return structuralReason;
  const sourceReason = validateSourceReconciliation(item, region, options);
  const qualityReason = validateKoreanSoundEffectQuality(
    item,
    region,
    targetLanguage,
    options,
  );
  return [sourceReason, qualityReason].filter(Boolean).join(" ") || null;
}

function validateSourceReconciliation(
  item: ParsedItem,
  region: SoundEffectReviewRegion,
  options: SoundEffectTranslationValidationOptions,
): string | null {
  const ocrSource = region.recognizedText?.trim();
  if (!ocrSource || !hasJapaneseSourceMismatch(region, item)) return null;
  if (options.allowOcrMismatch) return null;
  return "Hayai OCR의 유효한 일본어 판독과 달라 반복 글자를 포함해 이미지를 다시 확인해야 합니다.";
}

function validateKoreanSoundEffectQuality(
  item: ParsedItem,
  region: SoundEffectReviewRegion,
  targetLanguage: string,
  options: SoundEffectTranslationValidationOptions,
): string | null {
  if (!isKoreanTargetLanguage(targetLanguage)) return null;
  const sources = [item.confirmedSource, region.recognizedText ?? ""].map(
    normalizeSource,
  );
  const translation = normalizeKoreanTranslation(item.translation);
  return (
    validateCanonicalKoreanMeaning(sources, translation) ??
    validateKoreanActionMeaning(sources, translation) ??
    validateAmbiguousKoreanMeaning(sources, translation, options)
  );
}

function validateCanonicalKoreanMeaning(
  sources: readonly string[],
  translation: string,
): string | null {
  if (
    sources.some((source) => source.includes("バタン")) &&
    translation.includes("철컥")
  ) {
    return "バタン은 문이나 몸이 세게 닫히는 장면의 쾅/탕 계열이며 철컥이 아닙니다.";
  }
  if (
    sources.some((source) => /^(?:チ){2,}$/u.test(source)) &&
    translation.startsWith("치치")
  ) {
    return "チチチ를 일본어 음절대로 치치치로 옮기지 말고 장면의 실제 소리를 한국어로 번역해야 합니다.";
  }
  if (
    sources.some(
      (source) => source.includes("プンプン") || source.includes("ぷんぷん"),
    ) &&
    translation.includes("뿡")
  ) {
    return "ぷんぷん 분노 표현을 방귀 소리로 오역했습니다.";
  }
  if (
    sources.some(
      (source) => source.includes("プンプン") || source.includes("ぷんぷん"),
    ) &&
    translation.includes("볼")
  ) {
    return "ぷんぷん을 장면 설명문으로 풀지 말고 짧고 자연스러운 분노 효과음으로 옮겨야 합니다.";
  }
  if (
    sources.some(
      (source) => source.includes("ハハ") || source.includes("はは"),
    ) &&
    /^(?:하아|하앗)/u.test(translation)
  ) {
    return "ハハ 반복 웃음과 ハッ/はぁ 숨소리를 혼동했습니다. 원문 글자를 다시 판독해야 합니다.";
  }
  return null;
}

function validateAmbiguousKoreanMeaning(
  sources: readonly string[],
  translation: string,
  options: SoundEffectTranslationValidationOptions,
): string | null {
  if (
    !options.allowAmbiguousKoreanMeaning &&
    sources.some((source) => source.includes("ブンブン")) &&
    /^(?:부릉|부웅)/u.test(translation)
  ) {
    return "ブンブン이 모터 소리인지 사람의 흔들기·휘두르기인지 전체 장면에서 다시 판별해야 합니다.";
  }
  return null;
}

function validateKoreanActionMeaning(
  sources: readonly string[],
  translation: string,
): string | null {
  if (
    sources.some((source) => source.includes("つるっ")) &&
    translation.includes("매끈")
  ) {
    return "つるっ 미끄러짐을 표면 상태인 매끈으로 옮기지 말고 실제 움직임 효과음으로 번역해야 합니다.";
  }
  if (
    sources.some((source) => source.includes("イラッ")) &&
    translation.includes("울컥")
  ) {
    return "イラッ의 순간적인 짜증과 울컥하는 감정을 혼동했습니다.";
  }
  if (
    sources.some((source) => source.includes("くるっ")) &&
    translation.includes("스윽")
  ) {
    return "くるっ의 빠른 회전을 느린 이동 표현인 스윽으로 옮겼습니다.";
  }
  if (
    sources.some((source) => source.includes("キッ")) &&
    translation === "큭"
  ) {
    return "キッ이 날카로운 시선인지 힘주는 동작인지 장면에서 판별해야 하며 신음인 큭으로 바로 옮길 수 없습니다.";
  }
  return null;
}

function validateCertainItem(
  item: ParsedItem,
  targetLanguage: string,
): string | null {
  if (!item.confirmedSource || !containsJapanese(item.confirmedSource)) {
    return "확인한 일본어 원문이 없습니다.";
  }
  if (!item.translation || item.translation.length > 120) {
    return "번역문이 비어 있거나 지나치게 깁니다.";
  }
  if (containsJapanese(item.translation)) {
    return "번역문에 일본어가 남아 있습니다.";
  }
  if (isInvalidKoreanTranslation(item.translation, targetLanguage)) {
    return "한국어 번역문이 아닙니다.";
  }
  return null;
}

function isInvalidKoreanTranslation(
  translation: string,
  targetLanguage: string,
): boolean {
  return (
    isKoreanTargetLanguage(targetLanguage) &&
    !/[가-힣ㄱ-ㅎㅏ-ㅣ]/u.test(translation)
  );
}

function isKoreanTargetLanguage(targetLanguage: string): boolean {
  const normalized = targetLanguage.trim().toLowerCase();
  return normalized === "ko" || normalized.startsWith("ko-");
}

function containsJapanese(value: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/u.test(value);
}

function sourceSimilarity(left: string, right: string): number {
  const a = normalizeSource(left);
  const b = normalizeSource(right);
  if (!a || !b) return 0;
  if (a === b || a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }
  const aChars = [...a];
  const bChars = [...b];
  const common = new Set(aChars.filter((char) => bChars.includes(char))).size;
  return (common * 2) / (aChars.length + bChars.length);
}

function normalizeSource(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

function hasJapaneseSourceMismatch(
  region: SoundEffectReviewRegion,
  item: ParsedItem,
): boolean {
  const ocrSource = region.recognizedText?.trim();
  return Boolean(
    ocrSource &&
    containsJapanese(ocrSource) &&
    sourceSimilarity(ocrSource, item.confirmedSource) < 0.72,
  );
}

function appendOcrOverrideWarning(
  warnings: string[],
  item: ParsedItem,
  region: SoundEffectReviewRegion,
  options: SoundEffectTranslationValidationOptions,
): void {
  if (!options.allowOcrMismatch || !hasJapaneseSourceMismatch(region, item)) {
    return;
  }
  warnings.push(
    `${item.regionId}: Hayai OCR과 두 번째 이미지 판독이 달라 재판독 결과를 사용했습니다.`,
  );
}

function normalizeKoreanTranslation(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}
