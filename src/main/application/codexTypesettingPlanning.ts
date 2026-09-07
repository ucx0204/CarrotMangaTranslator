import type { CodexPageReading } from "../../shared/codexTypesettingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type {
  CodexChapterPlan,
  CodexTypesettingPorts,
  TypesettingImage,
  TypesettingIssue,
  TypesettingLayout,
  TypesettingPageImage,
} from "./codexTypesettingContracts";
import {
  assignCodexBatchViews,
  codexBatchStage,
  codexBatchImages,
  partitionCodexReading,
} from "./codexTypesettingBatches";
import { pageLayoutPrompt, pageReviewPrompt } from "./codexTypesettingPrompts";
import { preservedReadingConflicts } from "./codexTypesettingFallback";
import {
  assertExactMembership,
  layoutsSchema,
  reviewSchema,
} from "./codexTypesettingValidation";

export async function planCodexPageLayouts(
  page: MangaPage,
  reading: CodexPageReading,
  plan: CodexChapterPlan,
  images: {
    source: TypesettingPageImage[];
    samples: TypesettingImage[];
    preview?: TypesettingPageImage[];
  },
  repair: { attempt: number; issues: TypesettingIssue[] },
  ports: CodexTypesettingPorts,
): Promise<TypesettingLayout[]> {
  const batches = partitionCodexReading(reading, 16);
  const sources = assignCodexBatchViews(page, batches, images.source);
  const previews = images.preview
    ? assignCodexBatchViews(page, batches, images.preview)
    : undefined;
  const layouts: TypesettingLayout[] = [];
  for (const [index, batch] of batches.entries()) {
    ports.signal.throwIfAborted();
    ports.progress({ step: "layout", part: index + 1, parts: batches.length });
    const ids = batch.regions
      .filter((region) => region.action !== "keep")
      .map((region) => region.id);
    const style = {
      ...plan,
      groups: plan.groups.map((group) => ({
        ...group,
        members: group.members.filter((member) =>
          ids.includes(member.regionId),
        ),
      })),
    };
    const result = layoutsSchema.parse(
      await ports.ask(
        codexBatchStage(
          `layout-${page.id}-${repair.attempt}`,
          index,
          batches.length,
        ),
        pageLayoutPrompt(
          page,
          batch,
          style,
          repair.issues.filter((issue) => ids.includes(issue.regionId)),
        ) +
          "\nRegions with translationLocked=true contain exact USER-APPROVED text. Preserve every character, repetition and syllable exactly. Do not rewrite, retranslate, expand, shorten or add punctuation to approved text. Fit the lettering to that fixed text.",
        [
          ...sources[index],
          ...images.samples,
          ...codexBatchImages(previews?.[index] ?? [], batch),
        ],
      ),
    );
    assertExactMembership(
      ids,
      result.layouts.map((layout) => layout.regionId),
      "Layout batch",
    );
    layouts.push(
      ...result.layouts.map((layout) => {
        const region = batch.regions.find(
          (region) => region.id === layout.regionId,
        );
        if (!region?.translationLocked) return layout;
        const approved = region.translatedText;
        return {
          ...layout,
          translatedText: approved,
          runs:
            layout.runs?.map((run) => run.text).join("") === approved
              ? layout.runs
              : undefined,
        };
      }),
    );
  }
  return layouts;
}

export async function reviewCodexPageBatches(
  page: MangaPage,
  reading: CodexPageReading,
  source: TypesettingPageImage[],
  preview: TypesettingPageImage[],
  attempt: number,
  ports: CodexTypesettingPorts,
): Promise<{ issues: TypesettingIssue[] }> {
  const batches = partitionCodexReading(reading, 16);
  const sources = assignCodexBatchViews(page, batches, source);
  const previews = assignCodexBatchViews(page, batches, preview);
  const issues: TypesettingIssue[] = preservedReadingConflicts(
    reading,
    page,
    ports.blockId,
    preview,
  );
  issues.push(...measuredOverflowIssues(reading, preview));
  for (const [index, batch] of batches.entries()) {
    ports.signal.throwIfAborted();
    ports.progress({ step: "review", part: index + 1, parts: batches.length });
    const result = reviewSchema.parse(
      await ports.ask(
        codexBatchStage(`review-${page.id}-${attempt}`, index, batches.length),
        pageReviewPrompt(batch) +
          (ports.eraseOriginal === false
            ? " Original erasure is OFF. Source lettering remaining in the background is intentional; do not report that as an issue."
            : ""),
        [...sources[index], ...codexBatchImages(previews[index], batch)],
      ),
    );
    if (
      result.issues.some(
        (issue) =>
          !batch.regions.some(
            (region) =>
              region.action !== "keep" && region.id === issue.regionId,
          ),
      )
    )
      throw new Error("Review batch returned an unrequested region.");
    issues.push(...result.issues);
  }
  return { issues };
}

function measuredOverflowIssues(
  reading: CodexPageReading,
  preview: TypesettingPageImage[],
): TypesettingIssue[] {
  const overflowIds = new Set(
    preview
      .flatMap((image) => image.measurements ?? [])
      .filter((item) => item.overflow)
      .map((item) => item.regionId),
  );
  return reading.regions
    .filter((region) => region.action !== "keep" && overflowIds.has(region.id))
    .map((region) => ({
      regionId: region.id,
      kind: "text",
      reason:
        "실제 렌더러에서 번역 글자가 배치 영역을 넘칩니다. 글자 크기와 줄 나눔을 조정하세요.",
    }));
}
