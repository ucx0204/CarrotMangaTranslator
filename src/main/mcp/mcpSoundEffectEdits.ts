import { createHash } from "node:crypto";
import type { MangaPage } from "../../shared/libraryTypes";
import type { McpSoundEffectPrepare } from "../../shared/mcpSoundEffects";
import type { BlockFormatDefaults } from "../../shared/blockFormat";
import { normalizeBboxTo1000 } from "../../shared/bboxNormalization";
import {
  normalizedRegionToPixelRect,
  type PixelRect,
} from "../../shared/region";
import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../../shared/pageRevision";
import {
  resolvePendingSoundEffectReviewRegions,
  reviewRegionConflictsWithBlock,
} from "../../shared/soundEffectReview";
import { toPlainSoundEffectBlock } from "../../shared/soundEffectBlocks";
import { applySoundEffectReviewDraft } from "../libraryStore/librarySoundEffectReviewDraft";
import { restoreSoundEffectReviewPage } from "../libraryStore/librarySoundEffectRestore";
import { applyResolvedSoundEffectEntries } from "../libraryStore/librarySoundEffectMutations";
import { prepareMcpReading } from "../application/mcpReadingPolicy";
import { McpEditError } from "../application/mcpEditPolicy";

export function projectSoundEffectReview(
  page: MangaPage,
  input: McpSoundEffectPrepare,
): MangaPage {
  const command = input.command;
  if (command.kind !== "review")
    throw new McpEditError("invalid_edit", "Expected review decisions.");
  unique(command.decisions.map((item) => item.regionId));
  unique(command.additions.map((item) => item.key));
  const now = new Date().toISOString();
  const restore = command.decisions
    .filter((item) => item.action === "restore")
    .map((item) => item.regionId);
  let next = restore.length
    ? {
        ...page,
        ...restoreSoundEffectReviewPage(
          page,
          {
            pageId: page.id,
            pageRevision: createSoundEffectReviewPageRevision(page),
            regionIds: restore,
          },
          now,
        ),
      }
    : page;
  const normalized = next.blocks.map((block) => ({
    ...block,
    bbox: normalizeBboxTo1000(block.bbox, next, block.bboxSpace),
  }));
  const pending = resolvePendingSoundEffectReviewRegions(
    next.soundEffectReview,
    normalized,
  );
  const pendingIds = new Set(pending.map((item) => item.id));
  const addedRegions = command.additions.map((item) => ({
    regionId: manualId(input.requestId, item.key),
    bbox: checkedBbox(page, item.sourceRect),
  }));
  for (const item of command.decisions)
    if (
      !pendingIds.has(item.regionId) ||
      (item.action === "exclude" && item.sourceRect)
    )
      throw new McpEditError(
        "invalid_edit",
        "Review decisions require an available candidate; excluded geometry is not edited.",
      );
  const dismissedRegionIds = command.decisions
    .filter((item) => item.action === "exclude")
    .map((item) => item.regionId);
  const editedRegions = command.decisions.flatMap((item) =>
    item.sourceRect
      ? [{ regionId: item.regionId, bbox: checkedBbox(page, item.sourceRect) }]
      : [],
  );
  const projected = applySoundEffectReviewDraft(
    { ...next, blocks: normalized },
    {
      pageId: page.id,
      pageRevision: createSoundEffectReviewPageRevision(next),
      includedRegionIds: [...pendingIds]
        .filter((id) => !dismissedRegionIds.includes(id))
        .concat(addedRegions.map((item) => item.regionId)),
      dismissedRegionIds,
      editedRegions,
      addedRegions,
    },
    now,
  );
  next = { ...next, soundEffectReview: projected.page.soundEffectReview };
  return next;
}
export function materializeSoundEffects(
  page: MangaPage,
  input: McpSoundEffectPrepare,
  defaults: BlockFormatDefaults | undefined,
): MangaPage {
  if (input.command.kind !== "materialize")
    throw new McpEditError(
      "invalid_edit",
      "Expected reviewed sound-effect text.",
    );
  unique(input.command.entries.map((item) => item.regionId));
  if (page.blocks.length + input.command.entries.length > 5000)
    throw new McpEditError(
      "invalid_edit",
      "The native block limit would be exceeded.",
    );
  const normalized = page.blocks.map((block) => ({
    ...block,
    bbox: normalizeBboxTo1000(block.bbox, page, block.bboxSpace),
  }));
  const pending = resolvePendingSoundEffectReviewRegions(
    page.soundEffectReview,
    normalized,
  );
  const entries = input.command.entries.map((entry) => {
    const region = pending.find((region) => region.id === entry.regionId);
    if (!region)
      throw new McpEditError(
        "not_found",
        "The sound-effect candidate is no longer pending.",
      );
    if (
      !entry.allowOverlap &&
      normalized.some((block) =>
        reviewRegionConflictsWithBlock(region.bbox, block.bbox),
      )
    )
      throw new McpEditError(
        "invalid_edit",
        "Candidate overlaps an existing block; explicit allowOverlap is required.",
      );
    const reading = prepareMcpReading(
      page,
      {
        chapterId: input.chapterId,
        pageId: page.id,
        revision: createPageRevision(page),
        requestId: input.requestId,
        blocks: [
          {
            key: region.id,
            sourceRect: normalizedRegionToPixelRect(region.bbox, page, 1),
            sourceText: entry.sourceText,
            translatedText: entry.translatedText,
            textRole: "sound",
          },
        ],
      },
      defaults,
    );
    if (reading.alreadyApplied)
      throw new McpEditError(
        "revision_conflict",
        "This candidate was already materialized.",
      );
    return {
      regionId: region.id,
      block: toPlainSoundEffectBlock(reading.blocks[0]),
    };
  });
  return {
    ...page,
    ...applyResolvedSoundEffectEntries(page, entries, new Date().toISOString()),
  };
}
function checkedBbox(page: MangaPage, rect: PixelRect) {
  if (rect.x + rect.w > page.width || rect.y + rect.h > page.height)
    throw new McpEditError(
      "invalid_edit",
      "Sound-effect geometry must stay inside the original page.",
    );
  return normalizeBboxTo1000(rect, page, "pixels");
}
function manualId(requestId: string, key: string) {
  const value = createHash("sha256")
    .update(JSON.stringify([requestId, key]))
    .digest("hex");
  return `manual-${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
function unique(ids: string[]) {
  if (new Set(ids).size !== ids.length)
    throw new McpEditError(
      "invalid_edit",
      "Duplicate sound-effect targets are not allowed.",
    );
}
