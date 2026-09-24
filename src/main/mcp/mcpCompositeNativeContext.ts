import {
  mcpContextOutputSchemas,
  mcpContextRevision,
} from "../../shared/mcpContextEditing";
import {
  McpCompositeImportPreflightSchema,
  McpCompositeImportPreflightOutputSchema,
} from "../../shared/mcpCompositeWorkflow";
import type {
  McpCompositeImportAction,
  McpCompositeWorkflowAction,
} from "../../shared/mcpCompositeWorkflowActions";
import type { McpLibraryImportService } from "../application/mcpLibraryImportService";
import type {
  McpCompositeGuard,
  McpCompositeRecord,
} from "../application/mcpCompositeWorkflowPorts";
import type { McpWorkFileImports } from "./mcpWorkFileImports";
import { compositeFingerprint } from "../application/mcpCompositeWorkflowPolicy";
import type { CompositeNativeRead } from "./mcpCompositeNativeTools";
import type { McpCompositeNativePage } from "./mcpCompositeNativePages";
import { nativeCompositeCost, scopeError } from "./mcpCompositeNativeScope";

export type CompositeImportOptions = {
  imageReviewMapping: McpLibraryImportService["reviewMapping"];
  workFileReviewMapping: McpWorkFileImports["reviewMapping"];
};
export async function preflightCompositeImport(
  options: CompositeImportOptions,
  owner: string,
  input: unknown,
  guard: McpCompositeGuard,
) {
  const { phaseId, action } = McpCompositeImportPreflightSchema.parse(input);
  const review = await reviewImport(options, owner, action, guard);
  guard();
  return McpCompositeImportPreflightOutputSchema.parse({
    kind: "reviewed-import",
    phaseId,
    ...review,
  });
}
export async function costCompositeImport(
  options: CompositeImportOptions,
  record: McpCompositeRecord,
  action: McpCompositeImportAction,
  phaseId: string,
  guard: McpCompositeGuard,
) {
  if (
    record.plan.targets.kind !== "reviewed-import" ||
    record.targets.length ||
    phaseId !== record.plan.targets.phaseId
  )
    throw scopeError();
  const reviewed = await preflightCompositeImport(
    options,
    record.owner,
    { phaseId, action },
    guard,
  );
  if (
    compositeFingerprint(reviewed) !== compositeFingerprint(record.plan.targets)
  )
    throw scopeError();
  return nativeCompositeCost(reviewed.maxPages);
}
async function reviewImport(
  options: CompositeImportOptions,
  owner: string,
  action: McpCompositeImportAction,
  guard: McpCompositeGuard,
) {
  return action.kind === "import-create"
    ? options.imageReviewMapping(owner, action.input, guard)
    : options.workFileReviewMapping(owner, action.input, guard);
}

/** Read the exact owned proposal selection, including page memory targets; no edit is admitted. */
export async function inspectCompositeContext(
  read: CompositeNativeRead,
  owner: string,
  action: Extract<McpCompositeWorkflowAction, { kind: "context-apply" }>,
  values: McpCompositeNativePage[],
  guard: McpCompositeGuard,
) {
  const { first, changes } = await readContextChanges(
    read,
    owner,
    action.input.proposalId,
    guard,
  );
  const anchor = values.find(
    ({ target }) =>
      target.workId === first.workId && target.chapterId === first.chapterId,
  );
  if (!anchor || first.revision !== mcpContextRevision(anchor.saved))
    throw scopeError();
  assertContextChanges(first, changes, action.input.selectedChangeIds, values);
  return {
    workId: first.workId,
    chapterId: first.chapterId,
    revision: first.revision,
  };
}
type ContextView = ReturnType<
  typeof mcpContextOutputSchemas.carrot_get_context_proposal.parse
>;
async function readContextChanges(
  read: CompositeNativeRead,
  owner: string,
  proposalId: string,
  guard: McpCompositeGuard,
) {
  const schema = mcpContextOutputSchemas.carrot_get_context_proposal;
  const changes: ContextView["changes"] = [];
  let offset = 0;
  let first: ContextView | undefined;
  do {
    const view = await read(
      schema,
      "carrot_get_context_proposal",
      { proposalId, offset, limit: 25 },
      owner,
      guard,
    );
    assertContextWindow(view, proposalId, offset, first);
    first ??= view;
    changes.push(...view.changes);
    if (view.nextOffset === null) break;
    if (
      !view.changes.length ||
      view.nextOffset !== offset + view.changes.length
    )
      throw scopeError();
    offset = view.nextOffset;
  } while (changes.length <= 100);
  if (
    !first ||
    changes.length !== first.total ||
    new Set(changes.map((item) => item.changeId)).size !== changes.length
  )
    throw scopeError();
  return { first, changes };
}
function assertContextChanges(
  first: ContextView,
  changes: ContextView["changes"],
  ids: string[],
  values: McpCompositeNativePage[],
) {
  const selected = ids.map((id) =>
    changes.find((item) => item.changeId === id),
  );
  if (new Set(ids).size !== selected.length || selected.some((item) => !item))
    throw scopeError();
  for (const item of selected) {
    if (
      item?.entity === "memory" &&
      !values.some(
        ({ target }) =>
          target.workId === first.workId &&
          target.chapterId === first.chapterId &&
          target.pageId === item.targetId,
      )
    )
      throw scopeError();
  }
}
function assertContextWindow(
  view: ContextView,
  proposalId: string,
  offset: number,
  first?: ContextView,
) {
  if (
    view.proposalId !== proposalId ||
    view.total > 100 ||
    view.offset !== offset
  )
    throw scopeError();
  if (first && proposalIdentity(view) !== proposalIdentity(first))
    throw scopeError();
}
function proposalIdentity(view: ContextView) {
  return compositeFingerprint([
    view.proposalId,
    view.workId,
    view.chapterId,
    view.revision,
    view.changeIds,
    view.total,
  ]);
}
