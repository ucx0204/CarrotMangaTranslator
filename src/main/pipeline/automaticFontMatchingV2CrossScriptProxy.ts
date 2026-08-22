import type {
  FontStyleSelectionV2,
  RankedFontCandidateV2,
} from "../../shared/fontMatchingProfileTypes";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type {
  CrossScriptProxyCandidateV1,
  VerifiedAutomaticFontPixelInferenceV2,
  VerifiedCrossScriptProxyInferenceV1,
} from "./fontMatchingPagePixelInferenceTypes";

const CONTRACT_VERSION = "font-matching-cross-script-proxy-inference-v2";
const MODEL_VERSION = "manga-font-crossscript-proxy-runtime-v2";

export function applyCrossScriptProxyCandidateRanking(
  rankedCandidates: readonly RankedFontCandidateV2[],
  candidates: readonly AutomaticFontCandidate[],
  inference: VerifiedAutomaticFontPixelInferenceV2 | null,
): RankedFontCandidateV2[] | null {
  const proxy = readVerifiedCrossScriptProxy(inference, candidates);
  if (!proxy) return null;
  const proxyById = new Map(
    proxy.candidates.map((candidate, index) => [
      candidate.fontId,
      { candidate, index },
    ]),
  );
  return [...rankedCandidates]
    .sort((left, right) => {
      const leftIndex =
        proxyById.get(left.fontId)?.index ?? Number.MAX_SAFE_INTEGER;
      const rightIndex =
        proxyById.get(right.fontId)?.index ?? Number.MAX_SAFE_INTEGER;
      return (
        leftIndex - rightIndex || compareStrings(left.fontId, right.fontId)
      );
    })
    .map((candidate, index) => {
      const proxyCandidate = proxyById.get(candidate.fontId)?.candidate;
      return {
        ...candidate,
        rank: index + 1,
        totalScore: proxyCandidate ? 1 / (1 + proxyCandidate.score) : -1,
        confidence: proxyCandidate ? 1 : candidate.confidence,
        reasonCodes: proxyCandidate
          ? [...candidate.reasonCodes, "cross_script_visual_voice_v1"]
          : [...candidate.reasonCodes],
      };
    });
}

export function hasVerifiedCrossScriptProxyInference(
  inference: VerifiedAutomaticFontPixelInferenceV2 | null,
  candidates: readonly AutomaticFontCandidate[],
): boolean {
  return readVerifiedCrossScriptProxy(inference, candidates) !== null;
}

export function resolveCrossScriptProxySelectionStyle(
  inference: VerifiedAutomaticFontPixelInferenceV2 | null,
  candidates: readonly AutomaticFontCandidate[],
  fontId: string,
): FontStyleSelectionV2 | null {
  const proxy = readVerifiedCrossScriptProxy(inference, candidates);
  const candidate = proxy?.candidates.find((entry) => entry.fontId === fontId);
  return candidate
    ? {
        fontId,
        fontWeight: candidate.fontWeight,
        italic: candidate.italic,
      }
    : null;
}

// The result is an external worker boundary, so all sealed fields fail closed.
// eslint-disable-next-line complexity
function readVerifiedCrossScriptProxy(
  inference: VerifiedAutomaticFontPixelInferenceV2 | null,
  candidates: readonly AutomaticFontCandidate[],
): VerifiedCrossScriptProxyInferenceV1 | null {
  const proxy = inference?.crossScriptProxy;
  if (
    !proxy ||
    proxy.kind !== "verified_cross_script_proxy" ||
    proxy.contractVersion !== CONTRACT_VERSION ||
    proxy.modelVersion !== MODEL_VERSION ||
    !Number.isInteger(proxy.voice) ||
    !Number.isInteger(proxy.voiceCount) ||
    proxy.voice < 1 ||
    proxy.voiceCount < 1 ||
    proxy.voice > proxy.voiceCount ||
    proxy.voiceCount > 4 ||
    !Array.isArray(proxy.candidates) ||
    proxy.candidates.length !== candidates.length
  ) {
    return null;
  }
  const expectedIds = new Set(candidates.map((candidate) => candidate.fontId));
  const observedIds = new Set<string>();
  for (const candidate of proxy.candidates) {
    if (
      !isValidProxyCandidate(candidate) ||
      !expectedIds.has(candidate.fontId)
    ) {
      return null;
    }
    observedIds.add(candidate.fontId);
  }
  return observedIds.size === expectedIds.size ? proxy : null;
}

function isValidProxyCandidate(
  candidate: CrossScriptProxyCandidateV1,
): boolean {
  return (
    typeof candidate.fontId === "string" &&
    candidate.fontId.length > 0 &&
    typeof candidate.displayId === "string" &&
    candidate.displayId.length > 0 &&
    typeof candidate.score === "number" &&
    Number.isFinite(candidate.score) &&
    candidate.score >= 0 &&
    typeof candidate.fontWeight === "number" &&
    Number.isInteger(candidate.fontWeight) &&
    candidate.fontWeight >= 1 &&
    candidate.fontWeight <= 1000 &&
    typeof candidate.italic === "boolean"
  );
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
