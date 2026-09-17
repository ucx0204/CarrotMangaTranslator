import type { ChapterSnapshot } from "../../shared/libraryTypes";
import { createPageRevision } from "../../shared/pageRevision";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpBlockTranslationProposalSchema,
  type McpBlockTranslationProposal,
  type McpBlockTranslationTarget,
} from "../../shared/mcpBlockTranslation";
import { McpEditError } from "./mcpEditPolicy";
import type { McpOperationContext } from "./mcpOperationService";

/** Only this text projection crosses the model adapter boundary, never a page. */
export type McpBlockTranslationInput = {
  chapterId: string;
  workId: string;
  pageId: string;
  pageIndex: number;
  previousPageIds: string[];
  blockId: string;
  sourceText: string;
  textRole: "ordinary" | "sound";
  contextMode: "none" | "saved";
};
type Evidence = Pick<
  McpBlockTranslationProposal,
  | "translatedText"
  | "sourceLanguage"
  | "targetLanguage"
  | "model"
  | "execution"
  | "contextRevision"
> & { engine: string; contextPruned: boolean };
type Ports = {
  openChapter: (id: string) => Promise<ChapterSnapshot>;
  translate: (
    input: McpBlockTranslationInput,
    context: McpOperationContext,
  ) => Promise<Evidence>;
};

/** Proposal generation cannot persist a page. Explicit application reuses the
 * existing revision-checked translation editor, after this job releases its lease. */
export class McpBlockTranslationService {
  constructor(private readonly ports: Ports) {}

  async run(target: McpBlockTranslationTarget, context: McpOperationContext) {
    context.assertAuthorized();
    const selected = await this.load(target);
    const base = {
      chapterId: target.chapterId,
      pageId: target.pageId,
      blockId: target.blockId,
      revision: target.revision,
      pagesChanged: 0,
    };
    context.assertAuthorized();
    if (!selected.block.sourceText.trim())
      return {
        ...base,
        status: "no_source",
        noSourceText: true,
        performed: [],
        needsReview: true,
      };
    const evidence = await this.ports.translate(
      {
        chapterId: target.chapterId,
        workId: selected.workId,
        pageId: target.pageId,
        pageIndex: selected.pageIndex,
        previousPageIds: selected.previousPageIds,
        blockId: target.blockId,
        sourceText: selected.block.sourceText,
        textRole: selected.block.textRole === "sound" ? "sound" : "ordinary",
        contextMode: target.contextMode,
      },
      context,
    );
    context.assertAuthorized();
    const current = await this.load(target);
    context.assertAuthorized();
    if (current.membership !== selected.membership)
      throw new McpEditError(
        "revision_conflict",
        "Chapter membership or page order changed during translation.",
      );
    const { engine, contextPruned, ...publicEvidence } = evidence;
    const proposal = McpBlockTranslationProposalSchema.safeParse({
      ...publicEvidence,
      sourceText: selected.block.sourceText,
      previousTranslatedText: selected.block.translatedText,
      contextMode: target.contextMode,
      differs: selected.block.translatedText !== evidence.translatedText,
      requestCount: 1,
      warnings: [
        "review_before_apply",
        ...(evidence.translatedText === selected.block.sourceText
          ? ["same_as_source"]
          : []),
        ...(selected.block.generatedLettering
          ? ["generated_lettering_retained"]
          : []),
        ...(contextPruned ? ["context_budget_pruned"] : []),
        ...(target.contextMode === "saved"
          ? ["saved_context_may_have_changed"]
          : []),
      ],
    });
    if (!proposal.success)
      throw new McpEditError(
        "invalid_edit",
        "Invalid or excessive translation proposal. Nothing was saved.",
      );
    return {
      ...base,
      status: "proposed",
      engine,
      performed: ["block-translation"],
      needsReview: true,
      proposalExpired: false,
      blockTranslation: proposal.data,
    };
  }

  private async load(target: McpBlockTranslationTarget) {
    const chapter = await this.ports.openChapter(target.chapterId);
    const pages = chapter.pages.filter((page) => page.id === target.pageId);
    if (chapter.id !== target.chapterId || pages.length !== 1)
      throw new McpEditError("not_found", "A unique saved page is required.");
    const page = pages[0];
    if (createPageRevision(page) !== target.revision)
      throw new McpEditError(
        "revision_conflict",
        "Page changed. Read it again before translating or applying a proposal.",
      );
    const matches = page.blocks.filter((block) => block.id === target.blockId);
    if (matches.length !== 1)
      throw new McpEditError(
        matches.length ? "invalid_edit" : "not_found",
        "A unique existing block is required.",
      );
    const block = matches[0];
    if (
      ![block.sourceText, block.translatedText].every(
        (text) => typeof text === "string" && text.length <= 20_000,
      )
    )
      throw new McpEditError(
        "invalid_edit",
        "Saved text exceeds the proposal limit.",
      );
    return {
      block: structuredClone(block),
      workId: chapter.workId,
      pageIndex: chapter.pages.indexOf(page),
      previousPageIds: chapter.pages
        .slice(0, chapter.pages.indexOf(page))
        .map((item) => item.id),
      membership: hashStableValue([
        chapter.workId,
        chapter.pageOrder,
        chapter.pages.map((item) => item.id),
      ]),
    };
  }
}
