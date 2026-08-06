import type { OverlayItem, RequestSummary } from "./types";

type Hints = NonNullable<RequestSummary["ocrBboxHints"]>;

// OCR 힌트에서 인식 텍스트를 읽을 때 살펴볼 필드 순서. simple-page OCR 파서
// (ocr-text.cjs)와 동일한 의미 집합을 TS 검증 단에서도 쓴다.
const OCR_TEXT_KEYS = [
  "ocrText",
  "ocr_text",
  "text",
  "content",
  "block_content",
  "rec_text",
  "transcription",
];

/** OCR 힌트에서 인식 텍스트를 읽어 텍스트 근거 후보 판별에 쓴다. */
function readHintOcrText(hint: unknown): string {
  if (!hint || typeof hint !== "object") return "";
  const record = hint as Record<string, unknown>;
  for (const key of OCR_TEXT_KEYS) {
    const value = record[key];
    if (typeof value === "string") {
      const text = value.replace(/\s+/g, " ").trim();
      if (text) return text;
    }
  }
  return "";
}

/** 텍스트 근거가 있는 OCR 후보 id만 "모델이 커버해야 할 후보"로 간주한다. */
function collectTextCandidateIds(
  hints: Hints,
  candidateIds: Set<number>,
): Set<number> {
  const textIds = new Set<number>();
  for (const hint of hints) {
    const id = Number(hint?.id);
    if (
      Number.isInteger(id) &&
      id > 0 &&
      candidateIds.has(id) &&
      readHintOcrText(hint)
    ) {
      textIds.add(id);
    }
  }
  return textIds;
}

/** 수락된 항목이 커버하는 후보 id 집합(item.id 또는 candidateIds). */
function collectCoveredCandidateIds(
  accepted: OverlayItem[],
  candidateIds: Set<number>,
): Set<number> {
  const covered = new Set<number>();
  for (const item of accepted) {
    if (candidateIds.has(item.id)) covered.add(item.id);
    const candidateIdsField = Array.isArray(item.candidateIds)
      ? item.candidateIds
      : [];
    for (const cid of candidateIdsField) {
      if (candidateIds.has(cid)) covered.add(cid);
    }
  }
  return covered;
}

/**
 * 모델이 커버하지 못한 텍스트 후보 id를 반환한다. Path A는 모델 응답이 곧
 * 진실이라 완전성 검사가 없는데, 이 값이 "조용히 누락된 대사"의 흔적이 된다.
 * 모델이 여러 후보를 한 항목으로 병합하고 candidateIds를 기록한 경우는 커버로 친다.
 */
export function computeOmittedCandidateIds(
  hints: Hints,
  accepted: OverlayItem[],
  candidateIds: Set<number>,
): number[] {
  const textCandidateIds = collectTextCandidateIds(hints, candidateIds);
  const covered = collectCoveredCandidateIds(accepted, candidateIds);
  return [...textCandidateIds]
    .filter((id) => !covered.has(id))
    .sort((a, b) => a - b);
}
