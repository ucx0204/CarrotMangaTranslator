import { hashStableValue } from "../../shared/blockFingerprint";
import { createPageRevision, createSoundEffectReviewPageRevision } from "../../shared/pageRevision";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import type { McpWorkflowPrepare } from "../../shared/mcpWorkflow";
import type { AppSettings } from "../../shared/settingsTypes";
import type { McpWorkflowPage, McpWorkflowRecord } from "../application/mcpWorkflowPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { mcpBatchMembership } from "../application/mcpPageBatchPolicy";
import { readWorkContextForEdit } from "../library";
import { captureRetainedPage } from "./mcpRetentionEvidence";

/** Only a fingerprint is persisted; no settings, credentials or local model paths leave the app. */
export function workflowSettingsFingerprint(settings: AppSettings) {
  const { apiKey: _key, apiKeyCount: _count, profiles: _profiles, ...api } = settings.api;
  return hashStableValue({
    modelProvider: settings.modelProvider, gemma: settings.gemma, codex: settings.codex,
    api, ocr: settings.ocr, inpainting: settings.inpainting, hardware: settings.hardware,
    translation: settings.translation, blockFormatDefaults: settings.blockFormatDefaults,
    maxTokens: settings.maxTokens, ctx: settings.ctx,
  });
}
export async function readWorkflowPage(target: { chapterId: string; pageId: string }, guard: () => void) {
  guard();
  const saved = await readWorkContextForEdit(target.chapterId);
  const page = saved.chapter.pages.find((page) => page.id === target.pageId);
  if (!page || saved.chapter.id !== target.chapterId || saved.workId !== saved.chapter.workId)
    throw new McpEditError("not_found", "Workflow page no longer belongs to this chapter.");
  const state = await captureRetainedPage(page);
  const original = state.files.find((file) => file.path === page.imagePath);
  if (!original) throw new Error("Original workflow source evidence is missing.");
  guard();
  const evidence: McpWorkflowPage = {
    chapterId: target.chapterId, pageId: page.id, workId: saved.workId,
    revision: createPageRevision(page), reviewRevision: createSoundEffectReviewPageRevision(page),
    contextRevision: mcpContextRevision(saved), membership: mcpBatchMembership(saved.chapter),
    fingerprint: state.fingerprint,
    sourceFingerprint: hashStableValue([page.imagePath, page.width, page.height, original.sha256]),
  };
  return { evidence, page, saved };
}
export async function prepareWorkflowPages(input: McpWorkflowPrepare, guard: () => void) {
  const pages: McpWorkflowPage[] = [];
  for (const chapter of input.chapters) {
    const saved = await readWorkContextForEdit(chapter.chapterId);
    const selected = new Set(chapter.pages.map((page) => page.pageId));
    const ordered = saved.chapter.pages.filter((page) => selected.has(page.id));
    if (ordered.length !== selected.size)
      throw new McpEditError("not_found", "Some explicit workflow pages are missing.");
    for (const page of ordered) {
      const requested = chapter.pages.find((entry) => entry.pageId === page.id);
      const { evidence } = await readWorkflowPage({ chapterId: chapter.chapterId, pageId: page.id }, guard);
      if (evidence.revision !== requested?.revision)
        throw new McpEditError("revision_conflict", "A workflow target changed during preparation.");
      pages.push(evidence);
    }
  }
  return pages;
}
export function assertWorkflowIdentity(before: McpWorkflowPage, after: McpWorkflowPage) {
  if (before.workId !== after.workId || before.membership !== after.membership ||
      before.contextRevision !== after.contextRevision || before.sourceFingerprint !== after.sourceFingerprint)
    throw new McpEditError("revision_conflict", "Workflow source, chapter order or saved context changed.");
}
/** Changes on a single active page are accepted only after its exact native result is verified. */
export async function verifyWorkflowPages(record: McpWorkflowRecord, guard: () => void, changedPage?: number) {
  let changed: McpWorkflowPage | undefined;
  for (const [index, before] of record.pages.entries()) {
    const { evidence } = await readWorkflowPage(before, guard);
    assertWorkflowIdentity(before, evidence);
    if (index === changedPage) changed = evidence;
    else if (hashStableValue(before) !== hashStableValue(evidence))
      throw new McpEditError("revision_conflict", "A fixed workflow page changed outside this step. Prepare a new explicit plan.");
  }
  guard();
  return changed;
}
