import { keepFirstResultOnReviewFailure } from "./codexTypesettingReview";
import type { CodexPageReading } from "../../shared/codexTypesettingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type {
  CodexTypesettingPorts,
  TypesettingComposition,
} from "./codexTypesettingContracts";

/** Inspect the first result; review findings never trigger another generation. */
export async function prepareCodexBackground(
  page: MangaPage,
  reading: CodexPageReading,
  ports: CodexTypesettingPorts,
): Promise<
  TypesettingComposition & {
    reading: CodexPageReading;
    failedIds: string[];
    blockedIds: string[];
  }
> {
  ports.signal.throwIfAborted();
  ports.progress({ step: "background" });
  const cleaned = await ports.cleanPage(
    { ...page, blocks: [], blockOrder: [] },
    reading,
  );
  ports.preview?.(cleaned.page, undefined, "background");
  const review = await keepFirstResultOnReviewFailure(
    reading,
    ports,
    "background",
    `background-${page.id}`,
    () => ports.inspectBackground(cleaned, reading, 0),
    { corrections: [] },
  );
  const active = new Set(
    reading.regions
      .filter((region) => region.action !== "keep")
      .map((region) => region.id),
  );
  const issues = [
    ...cleaned.issues,
    ...review.issues,
    ...review.corrections.map((correction) => ({
      regionId: correction.regionId,
      kind: "background" as const,
      reason: correction.reason,
    })),
  ];
  if (issues.some((issue) => !active.has(issue.regionId)))
    throw new Error("배경 검수가 대상 밖 영역을 참조했습니다.");
  await ports.saveEvidence(`background-decision-${page.id}-0`, {
    reading,
    review,
    issues,
    status: issues.length ? "needs_review" : "verified",
  });
  return {
    ...cleaned,
    reading,
    failedIds: [...new Set(issues.map((issue) => issue.regionId))],
    blockedIds: [
      ...new Set([
        ...cleaned.issues.map((issue) => issue.regionId),
        ...review.issues
          .filter((issue) => issue.sourceRemaining)
          .map((issue) => issue.regionId),
      ]),
    ],
    issues,
  };
}
