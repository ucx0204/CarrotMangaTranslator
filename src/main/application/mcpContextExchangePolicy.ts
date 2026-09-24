import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpContextPreviewSchema,
  mcpContextRevision,
  type McpContextChangeSummary,
} from "../../shared/mcpContextEditing";
import {
  McpContextImportApplySchema,
  McpContextImportPreviewSchema,
  type McpContextImportApply,
  type McpContextImportDiagnostic,
  type McpContextImportPreview,
  type McpContextImportSelection,
} from "../../shared/mcpContextExchange";
import {
  parseMcpContextExchangePayload,
  type McpContextExchangePayload,
} from "../../shared/mcpContextExchangePayload";
import type { McpContextReferenceSnapshot } from "../../shared/mcpContextReferences";
import { ContextMigrationDeltaSchema } from "../../shared/mcpContextMigrationState";
import {
  buildContextProposalCommit,
  createContextProposal,
  selectContextProposal,
} from "./mcpContextProposalPolicy";
import { contextMigrationSnapshot } from "./mcpContextMigrationPolicy";
import { McpEditError } from "./mcpEditPolicy";

type Graph = McpContextReferenceSnapshot;
type Input = McpContextImportPreview | McpContextImportApply;

/** Select native fields, then reuse the existing reviewed edit and timestamp policy. */
export function prepareMcpContextImport(
  graph: Graph,
  value: McpContextExchangePayload,
  sourceSha256: string,
  input: Input,
  now: string,
  guard: () => void,
  nativeNormalization = false,
) {
  guard();
  const request =
    "selectedChangeIds" in input
      ? McpContextImportApplySchema.parse(input)
      : McpContextImportPreviewSchema.parse(input);
  const payload = parseMcpContextExchangePayload(value);
  const snapshot = contextImportSnapshot(graph, payload, request.chapterId);
  const evidence = contextImportEvidence(graph, sourceSha256, request, guard);
  const native = nativeContextImportPlan(
    snapshot,
    payload,
    request,
    evidence.planFingerprint,
    now,
    guard,
  );
  const result = contextImportDelta(graph, snapshot, native.commit, guard);
  return {
    ...evidence,
    ...result,
    beforeSnapshot: evidence.referenceSnapshot,
    changes: projectContextImportChanges(
      native.proposal.changes,
      request.selections,
    ),
    diagnostics: contextImportDiagnostics(
      payload,
      request.selections,
      nativeNormalization || native.normalized,
    ),
  };
}

function nativeContextImportPlan(
  snapshot: ReturnType<typeof contextImportSnapshot>,
  payload: McpContextExchangePayload,
  request: Input,
  fingerprint: string,
  now: string,
  guard: () => void,
) {
  const changes = request.selections.map((selection) =>
    compileSelection(payload, selection),
  );
  const nativeRequest = McpContextPreviewSchema.parse({
    chapterId: request.chapterId,
    requestId: request.requestId,
    revision: mcpContextRevision(snapshot),
    changes,
  });
  const clock = Date.parse(now);
  if (!Number.isFinite(clock))
    throw new Error("A native publication timestamp is required.");
  // This temporary policy result is never stored as a proposal or relabeled research.
  const proposal = createContextProposal(
    snapshot,
    "context-import",
    nativeRequest,
    "edit",
    [],
    [],
    fingerprint,
    clock,
    0,
  );
  const apply = {
    proposalId: proposal.metadata.proposalId,
    requestId: request.requestId,
    selectedChangeIds:
      "selectedChangeIds" in request
        ? request.selectedChangeIds
        : proposal.metadata.changeIds,
  };
  const subset = selectContextProposal(proposal, apply);
  const commit = buildContextProposalCommit(
    snapshot,
    proposal,
    subset,
    apply,
    clock,
    guard,
  );
  return {
    proposal,
    commit,
    normalized:
      hashStableValue(changes) !== hashStableValue(nativeRequest.changes),
  };
}

function contextImportDelta(
  graph: Graph,
  snapshot: ReturnType<typeof contextImportSnapshot>,
  commit: ReturnType<typeof buildContextProposalCommit>,
  guard: () => void,
) {
  const chapterId = snapshot.chapter.id;
  const delta = ContextMigrationDeltaSchema.parse({
    ...(commit.styleGuide
      ? { guide: { before: snapshot.styleGuide, after: commit.styleGuide } }
      : {}),
    memories: commit.storyMemory
      ? [{ chapterId, before: snapshot.storyMemory, after: commit.storyMemory }]
      : [],
    pages: [],
  });
  const after = {
    ...graph,
    styleGuide: commit.styleGuide ?? graph.styleGuide,
    chapters: graph.chapters.map((item) =>
      item.chapter.id === chapterId && commit.storyMemory
        ? { ...item, storyMemory: commit.storyMemory }
        : item,
    ),
  };
  guard();
  return {
    delta,
    afterSnapshot: contextMigrationSnapshot(after, chapterId, guard).snapshot,
  };
}

function contextImportSnapshot(
  graph: Graph,
  payload: McpContextExchangePayload,
  chapterId: string,
) {
  const anchors = graph.chapters.filter(
    (item) => item.chapter.id === chapterId,
  );
  if (
    graph.workId !== payload.source.workId ||
    chapterId !== payload.source.chapterId ||
    anchors.length !== 1
  )
    throw new McpEditError(
      "invalid_edit",
      "Context import requires the original work and anchor chapter.",
    );
  return {
    workId: graph.workId,
    workTitle: graph.workTitle,
    styleGuide: graph.styleGuide,
    ...anchors[0],
  };
}

function contextImportEvidence(
  graph: Graph,
  sourceSha256: string,
  input: Input,
  guard: () => void,
) {
  McpContextImportApplySchema.shape.sourceSha256.parse(sourceSha256);
  const referenceSnapshot = contextMigrationSnapshot(
    graph,
    input.chapterId,
    guard,
  ).snapshot;
  const planFingerprint = hashStableValue({
    kind: "context-import-v1",
    sourceSha256,
    workId: graph.workId,
    chapterId: input.chapterId,
    referenceSnapshot,
    selections: input.selections,
  });
  if (
    (input.planFingerprint && input.planFingerprint !== planFingerprint) ||
    ("referenceSnapshot" in input &&
      input.referenceSnapshot !== referenceSnapshot) ||
    ("sourceSha256" in input && input.sourceSha256 !== sourceSha256)
  )
    throw new McpEditError(
      "revision_conflict",
      "Context source, selected fields or native references changed. Preview again.",
    );
  return { referenceSnapshot, planFingerprint };
}

function compileSelection(
  payload: McpContextExchangePayload,
  selection: McpContextImportSelection,
) {
  let source: object;
  if (selection.entity === "memory") {
    if (payload.source.scope !== "guide-and-memory" || !payload.memory)
      throw new McpEditError(
        "invalid_edit",
        "Select a raw memory payload for memory fields.",
      );
    source = uniqueEntry(payload.memory.pages, "pageId", selection.pageId);
  } else {
    if (!payload.guide)
      throw new McpEditError(
        "invalid_edit",
        "An absent uploaded guide has no editable guide values.",
      );
    source =
      selection.entity === "rules"
        ? payload.guide.rules
        : uniqueEntry(
            selection.entity === "glossary"
              ? payload.guide.glossary
              : payload.guide.characters,
            "id",
            selection.entryId,
          );
  }
  const values: Record<string, unknown> = {};
  for (const field of selection.fields) {
    if (!Object.hasOwn(source, field))
      throw new McpEditError(
        "invalid_edit",
        "A selected optional field is absent; omission preserves its current value.",
      );
    values[field] = structuredClone((source as Record<string, unknown>)[field]);
  }
  const { fields: _fields, ...target } = selection;
  return { ...target, values };
}

function uniqueEntry(
  entries: readonly object[],
  key: string,
  id: string,
): object {
  const matches = entries.filter(
    (entry) => (entry as Record<string, unknown>)[key] === id,
  );
  if (matches.length !== 1)
    throw new McpEditError(
      "invalid_edit",
      "Selected context identity must occur exactly once in the uploaded payload.",
    );
  return matches[0];
}

function projectContextImportChanges(
  changes: McpContextChangeSummary[],
  selections: McpContextImportSelection[],
) {
  return changes.map((change, index) => {
    const selection = selections[index];
    const fields: string[] = [...selection.fields];
    if (selection.entity === "memory") {
      fields.push("pageName", "pageIndex");
      if (selection.fields.includes("visualSummary"))
        fields.push("visualSummarySource");
    }
    const pick = (value: McpContextChangeSummary["after"]) =>
      Object.fromEntries(
        fields
          .filter((field) => Object.hasOwn(value, field))
          .map((field) => [field, value[field]]),
      );
    return {
      ...change,
      before: change.before === null ? null : pick(change.before),
      after: pick(change.after),
    };
  });
}

function contextImportDiagnostics(
  payload: McpContextExchangePayload,
  selections: McpContextImportSelection[],
  normalized: boolean,
) {
  const catalog =
    (payload.guide?.glossary.length ?? 0) +
    (payload.guide?.characters.length ?? 0);
  const memories = payload.memory?.pages.length ?? 0;
  const diagnostics: McpContextImportDiagnostic[] = [
    {
      category: "identity",
      reason:
        "Same-work identity matching only; names never create, merge or remap IDs.",
      count: catalog + memories,
    },
    {
      category: "metadata",
      reason:
        "Imported timestamps and origins are inspect-only; the native edit policy preserves or updates native metadata.",
      count: catalog + memories + (payload.guide ? 1 : 0),
    },
    {
      category: "memory-evidence",
      reason:
        "Imported digests, text evidence, AI provenance and analysis times are inspect-only; existing native evidence is preserved, not certified fresh.",
      count: memories,
    },
    {
      category: "unselected",
      reason: "Unselected uploaded context targets are not applied.",
      count: Math.max(
        0,
        catalog + memories + (payload.guide ? 1 : 0) - selections.length,
      ),
    },
  ];
  if (normalized)
    diagnostics.push({
      category: "native-normalization",
      reason:
        "Existing native schema/edit normalization is shown in the reviewed after values.",
      count: 1,
    });
  const visual = selections.filter(
    (item) => item.entity === "memory" && item.fields.includes("visualSummary"),
  ).length;
  if (visual)
    diagnostics.push({
      category: "manual-visual-summary",
      reason:
        "The native edit policy marks selected visual summaries as manual; uploaded AI provenance is not applied.",
      count: visual,
    });
  return diagnostics;
}
