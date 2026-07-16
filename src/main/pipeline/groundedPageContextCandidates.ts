import type { PageContextPayload } from "./types";
import { evidenceContains } from "./pageContextEvidence";

export function sanitizeGroundedGlossaryCandidate(
  candidate: PageContextPayload["glossary"][number],
  sourceEvidence: string[],
  targetEvidence: string[],
): PageContextPayload["glossary"][number] | null {
  if (
    !candidate.source.trim() ||
    !candidate.target.trim() ||
    !evidenceContains(sourceEvidence, candidate.source) ||
    !evidenceContains(targetEvidence, candidate.target)
  ) {
    return null;
  }
  return {
    ...candidate,
    aliases: candidate.aliases?.filter((alias) =>
      evidenceContains(sourceEvidence, alias),
    ),
  };
}

export function sanitizeGroundedCharacterCandidate(
  candidate: PageContextPayload["characters"][number],
  sourceEvidence: string[],
  targetEvidence: string[],
): PageContextPayload["characters"][number] | null {
  const sourceNames = candidate.sourceNames.filter((name) =>
    evidenceContains(sourceEvidence, name),
  );
  if (
    sourceNames.length === 0 ||
    !candidate.targetName.trim() ||
    !evidenceContains(targetEvidence, candidate.targetName)
  ) {
    return null;
  }
  return {
    ...candidate,
    displayName: evidenceContains(targetEvidence, candidate.displayName)
      ? candidate.displayName
      : candidate.targetName,
    sourceNames,
    aliases: candidate.aliases?.filter((alias) =>
      evidenceContains(sourceEvidence, alias),
    ),
  };
}
