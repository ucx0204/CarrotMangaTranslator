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

export function validateSoundEffectTranslationResponse(
  payload: unknown,
  regions: readonly SoundEffectReviewRegion[],
  targetLanguage: string,
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
    const reason = validateItem(item, targetLanguage);
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
    appendOcrOverrideWarning(warnings, item, region);
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

function validateItem(item: ParsedItem, targetLanguage: string): string | null {
  if (item.confidence < 0 || item.confidence > 1) {
    return "confidence가 0~1 범위를 벗어났습니다.";
  }
  if (item.verdict === "uncertain") {
    return item.translation ? "불확실 판정에 번역문이 포함됐습니다." : null;
  }
  return validateCertainItem(item, targetLanguage);
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
  const japaneseResiduePattern = /^zh(?:-|$)/iu.test(targetLanguage.trim())
    ? /[\u3040-\u30ff]/u
    : /[\u3040-\u30ff\u3400-\u9fff]/u;
  if (japaneseResiduePattern.test(item.translation)) {
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
): void {
  if (!hasJapaneseSourceMismatch(region, item)) {
    return;
  }
  warnings.push(
    `${item.regionId}: OCR 참고문과 이미지 판독이 달라 이미지에서 읽은 원문을 사용했습니다.`,
  );
}

export function throwSoundEffectPhaseErrors(
  translationError: unknown,
  finalizationError: unknown,
): void {
  if (translationError && finalizationError) {
    throw new AggregateError(
      [translationError, finalizationError],
      "효과음 번역과 결과 저장이 모두 실패했습니다.",
    );
  }
  if (translationError) throw translationError;
  if (finalizationError) throw finalizationError;
}
