import type {
  WebImportCandidate,
  WebImportSizeFilter,
} from "../../../shared/webImportTypes";

const WEB_IMPORT_MEDIUM_MIN_PIXELS = 40_000;
const WEB_IMPORT_LARGE_MIN_PIXELS = 480_000;

export function candidateMatchesWebImportFilter(
  candidate: Pick<WebImportCandidate, "pixelCount">,
  filter: WebImportSizeFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "medium-or-larger") {
    return candidate.pixelCount >= WEB_IMPORT_MEDIUM_MIN_PIXELS;
  }
  return candidate.pixelCount >= WEB_IMPORT_LARGE_MIN_PIXELS;
}

export function filterWebImportCandidates(
  candidates: readonly WebImportCandidate[],
  filter: WebImportSizeFilter,
): WebImportCandidate[] {
  return candidates.filter((candidate) =>
    candidateMatchesWebImportFilter(candidate, filter),
  );
}

export function setVisibleWebImportSelection(
  manuallyExcluded: ReadonlySet<string>,
  visibleCandidateIds: readonly string[],
  selected: boolean,
): Set<string> {
  const next = new Set(manuallyExcluded);
  for (const id of visibleCandidateIds) {
    if (selected) next.delete(id);
    else next.add(id);
  }
  return next;
}
