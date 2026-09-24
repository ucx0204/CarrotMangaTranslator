import { hashStableValue } from "./blockFingerprint";
import type { MangaPage } from "./libraryTypes";
import type { PageStoryMemory, WorkStyleGuide } from "./workContextTypes";

/** Full saved text, not compact excerpts, image inspection or a quality certificate. */
function pageMemoryTextEvidence(page: MangaPage, guide: WorkStyleGuide) {
  const basis = {
    pageId: page.id,
    blockOrder: page.blockOrder ?? null,
    references: page.blocks.map((block) => [
      block.id,
      block.speakerId,
      block.glossaryEntryIds,
    ]),
  };
  const { createdAt: _created, updatedAt: _updated, ...context } = guide;
  return {
    sourceFingerprint: hashStableValue({
      ...basis,
      blocks: page.blocks.map((block) => [block.id, block.sourceText]),
    }),
    translationFingerprint: hashStableValue({
      ...basis,
      blocks: page.blocks.map((block) => [block.id, block.translatedText]),
    }),
    contextFingerprint: hashStableValue(context),
  };
}

/** Binds only refreshed text and its reference lists; visual summaries stay independent. */
export function pageMemorySummaryFingerprint(memory: PageStoryMemory) {
  return hashStableValue({
    summary: memory.summary,
    sourceDigest: memory.sourceDigest,
    translatedDigest: memory.translatedDigest,
    characterIds: memory.characterIds,
    glossaryEntryIds: memory.glossaryEntryIds,
  });
}

export function inspectPageMemoryEvidence(
  page: MangaPage,
  guide: WorkStyleGuide,
  memory: PageStoryMemory | undefined,
) {
  const current = pageMemoryTextEvidence(page, guide);
  if (!memory)
    return { status: "missing" as const, reasons: ["memory_missing"], current };
  if (!memory.textEvidence)
    return {
      status: "unknown" as const,
      reasons: ["legacy_memory_has_no_full_text_evidence"],
      current,
    };
  const saved = memory.textEvidence;
  const reasons: string[] = [];
  if (saved.sourceFingerprint !== current.sourceFingerprint)
    reasons.push("saved_source_order_or_references_changed");
  if (saved.translationFingerprint !== current.translationFingerprint)
    reasons.push("saved_translation_order_or_references_changed");
  if (saved.contextFingerprint !== current.contextFingerprint)
    reasons.push("work_context_changed");
  if (saved.summaryFingerprint !== pageMemorySummaryFingerprint(memory))
    reasons.push("memory_text_or_references_edited_after_refresh");
  return {
    status: reasons.length ? ("stale" as const) : ("current" as const),
    reasons,
    current,
  };
}
