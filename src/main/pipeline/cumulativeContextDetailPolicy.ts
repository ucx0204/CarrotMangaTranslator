import type { CumulativeContextDetail } from "../../shared/settingsTypes";
import type { PageContextPayload } from "./types";
import { normalizeEvidence } from "./pageContextEvidence";

const ESSENTIAL_CATEGORIES = new Set(["character", "alias", "place"]);

export function applyCumulativeContextDetailPolicy(
  pageContext: PageContextPayload | undefined,
  detail: CumulativeContextDetail,
  sourceEvidence: readonly string[],
): PageContextPayload | undefined {
  if (!pageContext || detail === "detailed") return pageContext;
  return {
    ...pageContext,
    glossary: pageContext.glossary.filter((candidate) => {
      if (detail === "balanced") return candidate.category !== "other";
      if (ESSENTIAL_CATEGORIES.has(candidate.category)) return true;
      return (
        candidate.category === "term" &&
        countEvidenceOccurrences(sourceEvidence, candidate.source) >= 2
      );
    }),
  };
}

function countEvidenceOccurrences(
  evidence: readonly string[],
  value: string,
): number {
  const needle = normalizeEvidence(value);
  if (!needle) return 0;
  return evidence.reduce((count, segment) => {
    const haystack = normalizeEvidence(segment);
    let offset = 0;
    let matches = 0;
    while ((offset = haystack.indexOf(needle, offset)) >= 0) {
      matches += 1;
      offset += needle.length;
    }
    return count + matches;
  }, 0);
}
