import { hashStableValue } from "../../shared/blockFingerprint";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import {
  McpTypographyAnalysisObservationSchema,
  type McpTypographyAnalysisObservation,
} from "../../shared/mcpTypographyAnalysis";
import {
  McpTypographyBatchPreviewSchema,
  projectMcpTypographyState,
  type McpTypographyBatchPreview,
  type McpTypographyChangeView,
} from "../../shared/mcpTypographyBatch";
import {
  mcpBatchMembership,
  requireBatchPage,
  validateBatchTargets,
} from "./mcpPageBatchPolicy";
import type { BatchPlan, BatchPage, BatchPolicy } from "./mcpPageBatchTypes";
import type { McpContextSnapshot } from "./mcpContextEditPolicy";
import { McpEditError } from "./mcpEditPolicy";

type Observation = McpTypographyAnalysisObservation;
type Selection = McpTypographyBatchPreview["pages"][number]["edits"][number];
type Evidence = Observation["pages"][number]["items"][number];
type TypographyChange = McpTypographyChangeView & {
  beforeBlock: TranslationBlock | null;
  afterBlock: TranslationBlock | null;
};
type TypographyPlan = BatchPlan<TypographyChange> & {
  observation: Observation;
};
export type TypographySnapshotRequest = {
  chapterId: string;
  pageId: string;
  revision: string;
  direction: "apply" | "undo" | "redo";
  blocks: TranslationBlock[];
  modes: Record<string, Selection["mode"]>;
  observation: Observation;
  dependencies: { pageId: string; revision: string }[];
};
export type TypographyPlanningPorts = {
  prepare: (
    saved: McpContextSnapshot,
    input: McpTypographyBatchPreview,
    access: { owner: string; guard: () => void },
  ) => Promise<{
    observation: Observation;
    project: (
      page: MangaPage,
      block: TranslationBlock,
      evidence: Evidence,
      edit: Selection,
    ) => {
      block: TranslationBlock;
      fontExclusion: string | null;
      sizeExclusion: string | null;
    };
  }>;
};

export function assertTypographyEvidence(
  saved: McpContextSnapshot,
  observation: Observation,
  dependencies = observation.pages.map(({ pageId, revision }) => ({
    pageId,
    revision,
  })),
) {
  if (
    saved.workId !== observation.workId ||
    mcpBatchMembership(saved.chapter) !== observation.membership ||
    mcpContextRevision(saved) !== observation.contextRevision
  )
    throw new McpEditError(
      "revision_conflict",
      "Typography work, chapter order or saved context changed.",
    );
  if (
    dependencies.length !== observation.pages.length ||
    new Set(dependencies.map((page) => page.pageId)).size !==
      dependencies.length ||
    dependencies.some(
      (page, index) => page.pageId !== observation.pages[index].pageId,
    )
  )
    throw new McpEditError(
      "invalid_edit",
      "Typography dependencies must retain the complete ordered analysis scope.",
    );
  for (const target of dependencies)
    requireBatchPage(saved.chapter, { ...target, edits: [] });
}

/** Narrow compared fields; geometry, text, images and all unrelated metadata stay protected. */
function permittedFields(mode: Selection["mode"]) {
  return new Set<string>([
    ...(mode === "size"
      ? []
      : [
          "fontFamily",
          "fontWeight",
          "bold",
          "italic",
          "outlineColor",
          "fontRole",
          "fontRoleConfidence",
        ]),
    ...(mode === "font"
      ? []
      : [
          "autoFitText",
          "fontSizePx",
          "fontSizeIntent",
          "sourceFontFacePx",
          "sourceFontSizeConfidence",
          "sourceFontSizeMethod",
        ]),
  ]);
}
function assertTypographyOnly(
  current: TranslationBlock,
  next: TranslationBlock,
  mode: Selection["mode"],
) {
  const allowed = permittedFields(mode);
  const protectedContent = (block: TranslationBlock) =>
    Object.fromEntries(
      Object.entries(block).filter(([key]) => !allowed.has(key)),
    );
  if (
    current.generatedLettering ||
    hashStableValue(protectedContent(current)) !==
      hashStableValue(protectedContent(next))
  )
    throw new McpEditError(
      "revision_conflict",
      "Typography cannot replace text, geometry, images or unrequested fields.",
    );
  projectMcpTypographyState(next);
}
export function applyMcpTypographySnapshots(
  page: MangaPage,
  request: TypographySnapshotRequest,
) {
  const selected = new Map(request.blocks.map((block) => [block.id, block]));
  if (
    !selected.size ||
    selected.size !== request.blocks.length ||
    selected.size !== Object.keys(request.modes).length
  )
    throw new McpEditError(
      "invalid_edit",
      "Distinct, explicitly scoped typography snapshots required.",
    );
  for (const [id, next] of selected) {
    const current = page.blocks.find((block) => block.id === id);
    const mode = request.modes[id];
    if (!current)
      throw new McpEditError(
        "not_found",
        "Typography target no longer exists.",
      );
    if (!["font", "size", "font-and-size"].includes(mode))
      throw new McpEditError("invalid_edit", "Typography mode is missing.");
    assertTypographyOnly(current, next, mode);
  }
  return page.blocks.map((block) =>
    structuredClone(selected.get(block.id) ?? block),
  );
}

function prepareChange(
  page: MangaPage,
  edit: Selection,
  observation: Observation,
  project: Awaited<ReturnType<TypographyPlanningPorts["prepare"]>>["project"],
): TypographyChange {
  const block = page.blocks.find((candidate) => candidate.id === edit.blockId);
  const evidence = observation.pages
    .find((item) => item.pageId === page.id)
    ?.items.find((item) => item.blockId === edit.blockId);
  if (!block || !evidence)
    throw new McpEditError(
      "not_found",
      "Select only blocks in the owned typography observation.",
    );
  const projected = project(page, structuredClone(block), evidence, edit);
  const next = projected.block;
  const excludedReason =
    projected.fontExclusion && projected.sizeExclusion
      ? [projected.fontExclusion, projected.sizeExclusion]
          .filter((reason) => reason !== "not_requested")
          .join(",") || "no_requested_evidence"
      : null;
  if (!excludedReason) assertTypographyOnly(block, next, edit.mode);
  const changed =
    !excludedReason && hashStableValue(block) !== hashStableValue(next);
  return {
    pageId: page.id,
    blockId: block.id,
    reason: edit.reason,
    requested: edit,
    before: projectMcpTypographyState(block),
    after: projectMcpTypographyState(excludedReason ? block : next),
    fontExclusion: projected.fontExclusion,
    sizeExclusion: projected.sizeExclusion,
    excludedReason,
    changed,
    warnings: [
      "verify_rendering_explicitly",
      "visible_source_face_is_not_nominal_font_size",
      "inline_markup_and_display_geometry_preserved",
    ],
    beforeBlock: changed ? structuredClone(block) : null,
    afterBlock: changed ? structuredClone(next) : null,
  };
}

export function createMcpTypographyBatchPolicy(
  ports: TypographyPlanningPorts,
  now = Date.now,
): BatchPolicy<
  McpTypographyBatchPreview,
  TypographyChange,
  TypographySnapshotRequest,
  McpTypographyChangeView,
  TypographyPlan
> {
  return {
    parse: (value) => McpTypographyBatchPreviewSchema.parse(value),
    plan: async (saved, input, access) => {
      validateBatchTargets(saved, input);
      const prepared = await ports.prepare(saved, input, access);
      access.guard();
      prepared.observation = McpTypographyAnalysisObservationSchema.parse(
        prepared.observation,
      );
      if (prepared.observation.expiresAt <= now())
        throw new McpEditError(
          "not_found",
          "Typography observation expired; run a new analysis before planning.",
        );
      assertTypographyEvidence(saved, prepared.observation);
      const pages = planTypographyPages(saved, input, prepared);
      pages.sort(
        (a, b) =>
          saved.chapter.pages.findIndex((page) => page.id === a.pageId) -
          saved.chapter.pages.findIndex((page) => page.id === b.pageId),
      );
      return {
        workId: saved.workId,
        membership: mcpBatchMembership(saved.chapter),
        pages,
        observation: structuredClone(prepared.observation),
      };
    },
    request: (page, input, direction, plan) => {
      const changed = page.changes.filter((change) => change.changed);
      return {
        chapterId: input.chapterId,
        pageId: page.pageId,
        revision: page.expectedRevision,
        direction,
        observation: plan.observation,
        dependencies: plan.observation.pages.map(({ pageId, revision }) => ({
          pageId,
          revision:
            plan.pages.find((target) => target.pageId === pageId)
              ?.expectedRevision ?? revision,
        })),
        modes: Object.fromEntries(
          changed.map((change) => [change.blockId, change.requested.mode]),
        ),
        blocks: changed.map((change) => {
          const block =
            direction === "undo" ? change.beforeBlock : change.afterBlock;
          if (!block)
            throw new McpEditError(
              "invalid_edit",
              "Excluded typography cannot be committed.",
            );
          return structuredClone(block);
        }),
      };
    },
    project: ({ beforeBlock: _before, afterBlock: _after, ...view }) =>
      structuredClone(view),
    inspectTool: "carrot_get_typography_batch",
    exclusionWarning:
      "inspect_typography_exclusions_and_dependency_requirements",
  };
}

function planTypographyPages(
  saved: McpContextSnapshot,
  input: McpTypographyBatchPreview,
  prepared: Awaited<ReturnType<TypographyPlanningPorts["prepare"]>>,
): BatchPage<TypographyChange>[] {
  return input.pages.map((target) => {
    const page = requireBatchPage(saved.chapter, target);
    const changes = target.edits.map((edit) =>
      prepareChange(page, edit, prepared.observation, prepared.project),
    );
    const changedBlocks = changes.filter((change) => change.changed).length;
    return {
      pageId: page.id,
      expectedRevision: target.revision,
      changes,
      changedBlocks,
      state: changedBlocks
        ? "pending"
        : changes.every((change) => change.excludedReason)
          ? "excluded"
          : "unchanged",
      result: "not_started",
      errorCode: null,
    };
  });
}
