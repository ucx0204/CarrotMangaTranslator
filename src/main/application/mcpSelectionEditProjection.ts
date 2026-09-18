import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { BlockFormatDefaults } from "../../shared/blockFormat";
import type { McpSelectionAnalysisItem } from "../../shared/mcpSelectionAnalysis";
import type { McpSelectionEdit } from "../../shared/mcpSelectionEditing";
import type { McpContextSnapshot } from "./mcpContextEditPolicy";
import { hashStableValue } from "../../shared/blockFingerprint";
import { createPageRevision } from "../../shared/pageRevision";
import { McpEditError } from "./mcpEditPolicy";
import { applyMcpBlockPatch } from "./mcpBlockEditPolicy";
import { prepareMcpReading } from "./mcpReadingPolicy";

type Context = {
  saved: McpContextSnapshot;
  page: MangaPage;
  edit: McpSelectionEdit;
  item?: McpSelectionAnalysisItem;
  requestId: string;
  defaults?: BlockFormatDefaults;
};
export type SelectionProjection = {
  blockId: string;
  before: TranslationBlock | null;
  after: TranslationBlock | null;
  excludedReason: string | null;
  sourceRect: { x: number; y: number; w: number; h: number } | null;
  overlapBlockIds: string[];
};

/** Calculate only requested fields; this boundary never saves or executes a model. */
export function projectMcpSelectionEdit(context: Context): SelectionProjection {
  const { page, edit, item } = context;
  if (edit.kind === "append") return projectDiscovery(context, edit);
  const id = edit.kind === "references" ? edit.blockId : item?.blockId;
  const block = page.blocks.find((candidate) => candidate.id === id);
  if (!block)
    throw new McpEditError("not_found", "Selected existing block is missing.");
  const excluded = block.generatedLettering
    ? "generated_lettering"
    : item?.excludedReason;
  let after = structuredClone(block);
  let excludedReason = excluded ?? null;
  if (!excludedReason) {
    if (edit.kind === "references")
      after = projectReferences(context.saved, block, edit);
    else {
      const observation = observedText(context, block, edit.kind);
      excludedReason = observation.trim()
        ? null
        : "empty_observation_keep_existing";
      if (!excludedReason) {
        const fields =
          edit.kind === "source"
            ? { sourceText: observation }
            : { translatedText: observation };
        after =
          applyMcpBlockPatch(context.saved.chapter, page, [
            { blockId: block.id, fields },
          ]).blocks.find((candidate) => candidate.id === block.id) ?? after;
      }
    }
  }
  return {
    blockId: block.id,
    before: structuredClone(block),
    after,
    excludedReason,
    sourceRect: null,
    overlapBlockIds: [],
  };
}

function observedText(
  context: Context,
  block: TranslationBlock,
  kind: "source" | "translation",
) {
  const item = requireItem(context);
  if (item.blockId !== block.id || item.regionId !== null)
    throw new McpEditError(
      "invalid_edit",
      "A saved-block observation is required for text replacement.",
    );
  if (kind === "source") {
    if (!item.ocr || item.ocr.previousSourceText !== block.sourceText)
      throw new McpEditError(
        "revision_conflict",
        "OCR evidence no longer matches the saved source text.",
      );
    return item.ocr.recognizedText;
  }
  const proposal = item.translation;
  if (
    !proposal ||
    proposal.sourceText !== block.sourceText ||
    proposal.previousTranslatedText !== block.translatedText
  )
    throw new McpEditError(
      "revision_conflict",
      "Translation evidence no longer matches this block.",
    );
  return proposal.translatedText;
}

function requireItem(context: Context) {
  const { item, page, edit } = context;
  if (
    !item ||
    !("itemId" in edit) ||
    item.itemId !== edit.itemId ||
    item.pageId !== page.id ||
    item.revision !== createPageRevision(page)
  )
    throw new McpEditError(
      "revision_conflict",
      "Select evidence for this exact page and revision.",
    );
  return item;
}

function projectReferences(
  saved: McpContextSnapshot,
  block: TranslationBlock,
  edit: Extract<McpSelectionEdit, { kind: "references" }>,
) {
  if (edit.speakerId === undefined && edit.glossaryEntryIds === undefined)
    throw new McpEditError(
      "invalid_edit",
      "Specify a reference field; null explicitly clears it.",
    );
  const next = structuredClone(block);
  if (edit.speakerId !== undefined) {
    if (edit.speakerId === null) delete next.speakerId;
    else {
      requireEnabledReferences([edit.speakerId], saved.styleGuide.characters);
      next.speakerId = edit.speakerId;
    }
  }
  if (edit.glossaryEntryIds !== undefined) {
    if (edit.glossaryEntryIds === null) delete next.glossaryEntryIds;
    else {
      requireEnabledReferences(
        edit.glossaryEntryIds,
        saved.styleGuide.glossary,
      );
      next.glossaryEntryIds = [...edit.glossaryEntryIds];
    }
  }
  return next;
}
function requireEnabledReferences(
  ids: string[],
  entries: { id: string; enabled: boolean }[],
) {
  if (new Set(ids).size !== ids.length)
    throw new McpEditError("invalid_edit", "Reference IDs must be distinct.");
  for (const id of ids) {
    const matches = entries.filter((entry) => entry.id === id);
    if (matches.length !== 1 || !matches[0].enabled)
      throw new McpEditError(
        "invalid_edit",
        "References must name unique enabled entries in this work.",
      );
  }
}

function projectDiscovery(
  context: Context,
  edit: Extract<McpSelectionEdit, { kind: "append" }>,
): SelectionProjection {
  const item = requireItem(context);
  if (!item.ocr || item.blockId !== null || item.regionId === null)
    throw new McpEditError(
      "invalid_edit",
      "Only a reviewed region OCR discovery can create a block.",
    );
  const matches = item.ocr.regions.filter(
    (region) => region.sequence === edit.sequence,
  );
  if (matches.length !== 1)
    throw new McpEditError(
      "not_found",
      "Select one exact discovered region sequence.",
    );
  const region = matches[0];
  const overlaps = item.overlaps.filter(
    (entry) => entry.sequence === edit.sequence,
  );
  if (overlaps.length !== 1)
    throw new McpEditError(
      "invalid_edit",
      "Discovery overlap evidence is incomplete.",
    );
  const overlapBlockIds = [...overlaps[0].blockIds];
  if (overlapBlockIds.length && !edit.allowOverlap)
    throw new McpEditError(
      "invalid_edit",
      "Review overlapping block IDs and explicitly allow overlap before append.",
    );
  const rect = containingPixels(region.sourceRect);
  if (region.sourceText.length > 8192)
    throw new McpEditError(
      "invalid_edit",
      "Discovery exceeds the native new-block text limit; no truncation occurred.",
    );
  const prepared = prepareMcpReading(
    context.page,
    {
      chapterId: context.saved.chapter.id,
      pageId: context.page.id,
      revision: createPageRevision(context.page),
      requestId: context.requestId,
      blocks: [
        {
          key: `selection-${hashStableValue([item.itemId, region.sequence])}`,
          sourceText: region.sourceText,
          translatedText: "",
          sourceRect: rect,
          sourceDirection: region.sourceDirection,
          textRole: region.textRole,
        },
      ],
    },
    context.defaults,
  );
  if (prepared.alreadyApplied)
    throw new McpEditError(
      "revision_conflict",
      "Discovery ID already exists; inspect the previous batch instead.",
    );
  return {
    blockId: prepared.blocks[0].id,
    before: null,
    after: prepared.blocks[0],
    sourceRect: rect,
    overlapBlockIds,
    excludedReason:
      item.excludedReason ??
      (region.sourceText.trim() ? null : "empty_discovery"),
  };
}
function containingPixels(rect: {
  x: number;
  y: number;
  w: number;
  h: number;
}) {
  const x = Math.floor(rect.x),
    y = Math.floor(rect.y);
  return {
    x,
    y,
    w: Math.ceil(rect.x + rect.w) - x,
    h: Math.ceil(rect.y + rect.h) - y,
  };
}
