import { hashStableValue } from "../../shared/blockFingerprint";
import {
  mcpContextOutputSchemas,
  mcpContextRevision,
} from "../../shared/mcpContextEditing";
import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../../shared/pageRevision";
import type {
  McpCompositeGuard,
  McpCompositeOutcome,
  McpCompositeRecord,
  McpCompositeSavedBinding,
} from "../application/mcpCompositeWorkflowPorts";
import { compositeFingerprint } from "../application/mcpCompositeWorkflowPolicy";
import { mcpBatchMembership } from "../application/mcpPageBatchPolicy";
import type { McpWorkflowPage } from "../application/mcpWorkflowPolicy";
import type { McpCompositeNativeCalls } from "./mcpCompositeNativeCalls";
import type {
  CompositeNativeOptions,
  CompositeSourceRead,
  CompositeContextAnchor,
} from "./mcpCompositeNativeResolve";
import {
  assertSoundEffectScope,
  readCompositeNativeBatch,
  type CompositeBatchFamily,
} from "./mcpCompositeNativeBatches";
import { verifyCompositeImportedPages } from "./mcpCompositeNativeImportedPages";
import { scopeError } from "./mcpCompositeNativeScope";
import { compositePageSourceFingerprint } from "./mcpCompositeNativePages";

type ContextProof = { anchor: CompositeContextAnchor; result: unknown };
type NativePage = CompositeSourceRead["values"][number];
type SnapshotPage = McpCompositeSavedBinding["snapshot"]["pages"][number];
type NativeBatch = Awaited<ReturnType<typeof readCompositeNativeBatch>>;
/** Refresh accepts only page mutations sealed by that exact settled native child. */
export async function verifyCompositeNativeRefresh(
  options: CompositeNativeOptions,
  calls: McpCompositeNativeCalls,
  record: McpCompositeRecord,
  binding: McpCompositeSavedBinding,
  outcome: McpCompositeOutcome,
  current: CompositeSourceRead,
  guard: McpCompositeGuard,
  context?: ContextProof,
) {
  if (binding.snapshot.policyFingerprint !== current.snapshot.policyFingerprint)
    throw scopeError();
  if (
    binding.family === "import-create" ||
    binding.family === "work-file-import"
  )
    return verifyCompositeImportedPages(
      options,
      calls,
      record,
      binding,
      outcome,
      current,
      guard,
    );
  assertStableEnvironment(binding, current);
  if (binding.family === "workflow-run")
    return verifyWorkflowPages(options, binding, outcome, current, guard);
  if (binding.family === "context-apply")
    return verifyContextPages(binding, current, context);
  if (isBatchFamily(binding.family))
    return verifyBatchPages(options, binding, outcome, current, guard);
  if (binding.snapshot.fingerprint !== current.snapshot.fingerprint)
    throw scopeError();
}
function assertStableEnvironment(
  binding: McpCompositeSavedBinding,
  current: CompositeSourceRead,
) {
  if (binding.snapshot.pages.length !== current.snapshot.pages.length)
    throw scopeError();
  for (const page of current.snapshot.pages) {
    const before = priorPage(binding, page.chapterId, page.pageId);
    if (
      page.workId !== before.workId ||
      page.membershipFingerprint !== before.membershipFingerprint ||
      page.fontFingerprint !== before.fontFingerprint ||
      page.settingsFingerprint !== before.settingsFingerprint ||
      compositeFingerprint(page.blockIds) !==
        compositeFingerprint(before.blockIds)
    )
      throw scopeError();
  }
}
async function verifyWorkflowPages(
  options: CompositeNativeOptions,
  binding: McpCompositeSavedBinding,
  outcome: McpCompositeOutcome,
  current: CompositeSourceRead,
  guard: McpCompositeGuard,
) {
  if (!binding.nativeReference || !options.workflow) throw scopeError();
  const evidence = await options.workflow.evidence(binding.owner, {
    id: outcome.receipt.id,
    requestId: binding.nativeRequestId,
    fingerprint: binding.nativeReference.fingerprint,
  });
  guard();
  if (!evidence?.length) throw scopeError();
  for (const value of current.values) {
    const saved = evidence.find(
      (page) =>
        page.chapterId === value.target.chapterId &&
        page.pageId === value.target.pageId,
    );
    const actual = current.snapshot.pages.find(
      (page) =>
        page.chapterId === value.target.chapterId &&
        page.pageId === value.target.pageId,
    );
    if (!saved) {
      if (
        compositeFingerprint(actual) !==
        compositeFingerprint(
          priorPage(binding, value.target.chapterId, value.target.pageId),
        )
      )
        throw scopeError();
    } else assertWorkflowPage(saved, value);
  }
  if (
    evidence.some(
      (page) =>
        !current.values.some(
          ({ target }) =>
            target.chapterId === page.chapterId &&
            target.pageId === page.pageId,
        ),
    )
  )
    throw scopeError();
}
function assertWorkflowPage(saved: McpWorkflowPage, value: NativePage) {
  if (
    saved.workId !== value.target.workId ||
    saved.revision !== createPageRevision(value.page) ||
    saved.reviewRevision !== createSoundEffectReviewPageRevision(value.page) ||
    saved.fingerprint !== value.state.fingerprint ||
    saved.membership !== mcpBatchMembership(value.saved.chapter) ||
    saved.contextRevision !== mcpContextRevision(value.saved)
  )
    throw scopeError();
}
async function verifyBatchPages(
  options: CompositeNativeOptions,
  binding: McpCompositeSavedBinding,
  outcome: McpCompositeOutcome,
  current: CompositeSourceRead,
  guard: McpCompositeGuard,
) {
  const family = binding.family;
  if (!isBatchFamily(family)) throw scopeError();
  const batch = await readCompositeNativeBatch(
    options,
    binding.owner,
    family,
    outcome.receipt.id,
    guard,
  );
  if (
    batch.summary.status !== "completed" ||
    batch.summary.activeRequestId !== binding.nativeRequestId ||
    batch.summary.direction !== "apply"
  )
    throw scopeError();
  for (const [index, page] of current.snapshot.pages.entries()) {
    const before = priorPage(binding, page.chapterId, page.pageId);
    verifyBatchPage(batch, page, before, current.values[index]);
  }
  if (
    batch.summary.pages.some(
      (page) =>
        !current.values.some(
          ({ target }) =>
            target.chapterId === batch.summary.chapterId &&
            target.pageId === page.pageId,
        ),
    )
  )
    throw scopeError();
}
function verifyBatchPage(
  batch: NativeBatch,
  page: SnapshotPage,
  before: SnapshotPage,
  value: NativePage,
) {
  const saved =
    batch.summary.chapterId === page.chapterId
      ? batch.summary.pages.find((item) => item.pageId === page.pageId)
      : undefined;
  const sourceFingerprint =
    saved && batch.soundPlan
      ? compositePageSourceFingerprint(
          value.state,
          batch.soundPlan.before.blocks,
        )
      : page.sourceFingerprint;
  if (
    sourceFingerprint !== before.sourceFingerprint ||
    page.contextFingerprint !== before.contextFingerprint ||
    page.memoryFingerprint !== before.memoryFingerprint
  )
    throw scopeError();
  if (!saved) {
    if (compositeFingerprint(page) !== compositeFingerprint(before))
      throw scopeError();
    return;
  }
  if (page.revision !== saved.expectedRevision) throw scopeError();
  if (batch.soundPlan)
    return assertSoundEffectScope(value, batch.soundPlan, true);
  if (
    `page-v1:${hashStableValue({ base: before.revision, soundEffectReview: value.page.soundEffectReview })}` !==
    before.reviewRevision
  )
    throw scopeError();
}
function verifyContextPages(
  binding: McpCompositeSavedBinding,
  current: CompositeSourceRead,
  proof?: ContextProof,
) {
  if (!proof) throw scopeError();
  const receipt = mcpContextOutputSchemas.carrot_apply_context_proposal.parse(
    proof.result,
  );
  if (
    receipt.requestId !== binding.nativeRequestId ||
    receipt.previousRevision !== proof.anchor.revision
  )
    throw scopeError();
  for (const [index, page] of current.snapshot.pages.entries()) {
    const before = priorPage(binding, page.chapterId, page.pageId);
    verifyContextPage(
      page,
      before,
      current.values[index],
      proof.anchor,
      receipt.revision,
    );
  }
}
function verifyContextPage(
  page: SnapshotPage,
  before: SnapshotPage,
  value: NativePage,
  anchor: CompositeContextAnchor,
  revision: string,
) {
  if (
    page.revision !== before.revision ||
    page.reviewRevision !== before.reviewRevision ||
    page.sourceFingerprint !== before.sourceFingerprint
  )
    throw scopeError();
  if (page.workId !== anchor.workId) {
    if (
      page.contextFingerprint !== before.contextFingerprint ||
      page.memoryFingerprint !== before.memoryFingerprint
    )
      throw scopeError();
  } else if (page.chapterId === anchor.chapterId) {
    if (mcpContextRevision(value.saved) !== revision) throw scopeError();
  } else if (page.memoryFingerprint !== before.memoryFingerprint)
    throw scopeError();
}
function isBatchFamily(family: string): family is CompositeBatchFamily {
  return [
    "selection-apply",
    "typography-apply",
    "lettering-apply",
    "sfx-apply",
  ].includes(family);
}
function priorPage(
  binding: McpCompositeSavedBinding,
  chapterId: string,
  pageId: string,
) {
  const before = binding.snapshot.pages.find(
    (page) => page.chapterId === chapterId && page.pageId === pageId,
  );
  if (!before) throw scopeError();
  return before;
}
