/* eslint-disable max-lines -- page-consistency policy passes remain colocated for deterministic ordering */
import {
  clusterAutomaticFontPrintedRows,
  isAutomaticFontPageTransferEligible,
  selectAutomaticFontPageAnchor,
  selectAutomaticFontStableMajorityPageAnchor,
  selectAutomaticFontStableMeanPageAnchor,
  type AutomaticFontPrintedFamily,
} from "./automaticFontMatchingV2PageFamily";
import { applyDohyeonDominanceClusterRescues } from "./automaticFontMatchingV2PageConsistencyDohyeonCluster";
import { applyDohyeonMorphologyRecoveryPlans } from "./automaticFontMatchingV2PageConsistencyDohyeonRecoveryPlan";
import { applyDominantOrdinaryRecoveries } from "./automaticFontMatchingV2PageConsistencyDominantOrdinary";
import { applyNeutralHeadEmphasisConsensus } from "./automaticFontMatchingV2PageConsistencyEmphasis";
import { buildInitialEvidenceRow } from "./automaticFontMatchingV2PageConsistencyEvidence";
import { applySplitGeometryComponents } from "./automaticFontMatchingV2PageConsistencyGeometry";
import { applyNeutralHeadOrdinaryConsensus } from "./automaticFontMatchingV2PageConsistencyOrdinary";
import { assertPageRelativeQaPolicyVersions } from "./fontMatchingPageRelativeRoleQa";
import {
  find,
  isDefined,
  resolveBestEligibleBodyCandidate,
  resolveCandidateBodyFamily,
  union,
  type AutomaticFontPageConsistencyState,
  type PageEvidenceRow,
  type PageGeometryItem,
} from "./automaticFontMatchingV2PageConsistencyShared";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";

const MINIMUM_PAGE_ANCHOR_SEED_COUNT = 2;
const MINIMUM_EXPLICIT_DIALOGUE_CONFIDENCE = 0.75;

export function buildPageConsistencyPlan(
  inferences: readonly (
    | VerifiedAutomaticFontPixelInferenceV2
    | null
    | undefined
  )[],
  items: readonly PageGeometryItem[],
): ReadonlyMap<string, AutomaticFontPageConsistencyState> {
  const rows = inferences.flatMap((inference, index) =>
    inference
      ? [
          buildInitialEvidenceRow(
            inference,
            resolvePageConsistencyGeometryItem(inference, items[index]),
          ),
        ]
      : [],
  );
  applySplitGeometryComponents(rows);
  const states = initializeVariantStates(rows);
  applyBodyGroupPlans(states, rows);
  applyStableMeanBodyConsensus(states, rows);
  applyNeutralHeadOrdinaryConsensus(states, rows);
  applyDohyeonDominanceClusterRescues(states, rows);
  applyDohyeonMorphologyRecoveryPlans(states, rows);
  applyNeutralHeadEmphasisConsensus(states, rows);
  applyDominantOrdinaryRecoveries(states, rows);
  applyPageRelativeQaConsistencyGuards(states, rows);
  return states;
}

/** QA-audited rows may never fall back to the model-authored item direction. */
function resolvePageConsistencyGeometryItem(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  item: PageGeometryItem | undefined,
): PageGeometryItem | undefined {
  if (!item || !inference.pageRelativeRoleQa) return item;
  return {
    ...item,
    direction:
      inference.pageRelativeRoleQa.sourceGeometryDirection?.direction ??
      inference.treatment.orientation,
  };
}

/**
 * Keep the opt-in dual-head experiment inside the morphology cluster that
 * authorized it. This runs after the existing page policy so rerouted rows
 * cannot silently move an untouched body row to a different page anchor.
 */
export function applyPageRelativeQaConsistencyGuards(
  states: Map<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): void {
  const auditedRows = rows.filter(
    (row) => row.inference.pageRelativeRoleQa !== undefined,
  );
  assertPageRelativeQaPolicyVersions(
    auditedRows.map((row) => row.inference.pageRelativeRoleQa ?? {}),
  );
  restoreBaselinePageRelativeStates(states, auditedRows);
  for (const cluster of groupPageRelativeQaClusters(auditedRows).values()) {
    applyPageRelativeQaClusterGuard(states, cluster);
  }
}

function restoreBaselinePageRelativeStates(
  states: Map<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): void {
  for (const row of rows) {
    const audit = row.inference.pageRelativeRoleQa;
    const baselineState = audit?.baselinePageConsistencyState;
    if (
      !baselineState ||
      (audit.status !== "unchanged" &&
        audit.status !== "reverted_apply_rate_guard" &&
        audit.status !== "dual_branch_unavailable")
    ) {
      continue;
    }
    states.set(row.inference.blockId, { ...baselineState });
  }
}

function groupPageRelativeQaClusters(
  rows: readonly PageEvidenceRow[],
): ReadonlyMap<string, PageEvidenceRow[]> {
  const clusters = new Map<string, PageEvidenceRow[]>();
  for (const row of rows) {
    const audit = row.inference.pageRelativeRoleQa;
    if (!audit?.clusterId || !audit.clusterBodyAnchorFontId) continue;
    const cluster = clusters.get(audit.clusterId) ?? [];
    cluster.push(row);
    clusters.set(audit.clusterId, cluster);
  }
  return clusters;
}

function applyPageRelativeQaClusterGuard(
  states: Map<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): void {
  const anchorFontIds = new Set(
    rows.map(
      (row) => row.inference.pageRelativeRoleQa?.clusterBodyAnchorFontId,
    ),
  );
  const anchorFontId = [...anchorFontIds][0];
  const printedFamily = anchorFontId
    ? resolveCandidateBodyFamily({ fontId: anchorFontId })
    : null;
  if (anchorFontIds.size !== 1 || !anchorFontId || !printedFamily) return;
  const eligibleRows = rows.filter((row) =>
    hasPageRelativeQaAnchorCandidate(row, anchorFontId),
  );
  const evidenceCount = eligibleRows.length;
  const supportShare = evidenceCount / rows.length;
  applyReroutedOrdinaryClusterAnchor(
    states,
    rows,
    anchorFontId,
    printedFamily,
    evidenceCount,
    supportShare,
  );
}

function applyReroutedOrdinaryClusterAnchor(
  states: Map<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
  anchorFontId: string,
  printedFamily: AutomaticFontPrintedFamily,
  evidenceCount: number,
  supportShare: number,
): void {
  const ordinaryRows = rows.filter(isAppliedPageRelativeOrdinaryRow);
  if (
    ordinaryRows.length < 2 ||
    !ordinaryRows.every((row) =>
      hasPageRelativeQaAnchorCandidate(row, anchorFontId),
    )
  ) {
    return;
  }
  for (const row of ordinaryRows) {
    states.set(row.inference.blockId, {
      ...states.get(row.inference.blockId),
      mode: "page_anchor",
      anchorFontId,
      anchorEvidenceCount: evidenceCount,
      anchorSupportShare: supportShare,
      printedFamily,
      recoveredBody: true,
      ordinaryMorphologyConsensus: true,
      emphasisMorphologyConsensus: false,
    });
  }
}

function isAppliedPageRelativeOrdinaryRow(row: PageEvidenceRow): boolean {
  const audit = row.inference.pageRelativeRoleQa;
  return Boolean(
    audit?.status === "applied" &&
    audit.originalRole === "emphasis_dialogue" &&
    audit.projectedRole === "dialogue" &&
    audit.routeFamily === "body" &&
    audit.reasonCodes.includes("page_relative_dominant_ordinary_morphology"),
  );
}

function hasPageRelativeQaAnchorCandidate(
  row: PageEvidenceRow,
  anchorFontId: string,
): boolean {
  return row.inference.localEvidence.rankedCandidates.some(
    (candidate) =>
      candidate.fontId === anchorFontId &&
      isAutomaticFontPageTransferEligible(candidate),
  );
}

function initializeVariantStates(
  rows: readonly PageEvidenceRow[],
): Map<string, AutomaticFontPageConsistencyState> {
  const states = new Map<string, AutomaticFontPageConsistencyState>();
  for (const row of rows) {
    if (!row.family) {
      states.set(
        row.inference.blockId,
        localVariantState(row.dohyeonMorphologyVeto),
      );
    }
  }
  return states;
}

function applyBodyGroupPlans(
  states: Map<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): void {
  for (const groupedRows of groupBodyRows(rows).values()) {
    for (const cluster of buildConnectedMorphologyClusters(groupedRows)) {
      applyBodyClusterPlan(states, cluster);
    }
  }
}

function groupBodyRows(
  rows: readonly PageEvidenceRow[],
): Map<string, PageEvidenceRow[]> {
  const groups = new Map<string, PageEvidenceRow[]>();
  for (const row of rows) {
    if (!row.family) continue;
    const direction =
      row.item?.direction ?? row.inference.treatment.orientation;
    const key = `${direction}:${row.family}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

/**
 * Page-wide ordinary-body consensus. The anchor is allowed to cross a noisy
 * local serif/sans route only when every row independently ranks the same
 * stable face in raw top3 at probability >= 0.15.
 */
function applyStableMeanBodyConsensus(
  states: Map<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): void {
  for (const group of groupStableMeanBodyRows(rows).values()) {
    if (
      group.some(
        (row) =>
          row.geometryComponentForced &&
          row.geometryComponentAnchorFontId !== null,
      )
    ) {
      continue;
    }
    const inferences = group.map(({ inference }) => inference);
    const unanimousAnchor = selectAutomaticFontStableMeanPageAnchor(inferences);
    const anchor = unanimousAnchor
      ? {
          ...unanimousAnchor,
          supportedBlockIds: inferences.map(({ blockId }) => blockId),
        }
      : selectAutomaticFontStableMajorityPageAnchor(inferences);
    const family = anchor
      ? resolveCandidateBodyFamily({ fontId: anchor.fontId })
      : null;
    if (!anchor || !family) continue;
    const supportedBlockIds = new Set(anchor.supportedBlockIds);
    for (const row of group) {
      if (!supportedBlockIds.has(row.inference.blockId)) continue;
      states.set(row.inference.blockId, {
        ...states.get(row.inference.blockId),
        mode: "page_anchor",
        anchorFontId: anchor.fontId,
        anchorEvidenceCount: anchor.evidenceCount,
        anchorSupportShare: anchor.supportShare,
        printedFamily: family,
        recoveredBody: row.recoveredBody,
        geometryComponentForced: row.geometryComponentForced,
        stableMeanConsensus: true,
        dohyeonMorphologyVeto: row.dohyeonMorphologyVeto,
      });
    }
  }
}

function groupStableMeanBodyRows(
  rows: readonly PageEvidenceRow[],
): Map<string, PageEvidenceRow[]> {
  const groups = new Map<string, PageEvidenceRow[]>();
  for (const row of rows) {
    if (!row.family && !isExplicitHighConfidenceDialogue(row)) continue;
    const direction =
      row.item?.direction ?? row.inference.treatment.orientation;
    const group = groups.get(direction) ?? [];
    group.push(row);
    groups.set(direction, group);
  }
  return groups;
}

function isExplicitHighConfidenceDialogue(row: PageEvidenceRow): boolean {
  return (
    row.item?.textRole === "ordinary" &&
    row.item.fontRole === "dialogue" &&
    typeof row.item.fontRoleConfidence === "number" &&
    Number.isFinite(row.item.fontRoleConfidence) &&
    row.item.fontRoleConfidence >= MINIMUM_EXPLICIT_DIALOGUE_CONFIDENCE
  );
}

function buildConnectedMorphologyClusters(
  rows: readonly PageEvidenceRow[],
): PageEvidenceRow[][] {
  const clusters = buildMorphologyClusters(rows);
  const parents = clusters.map((_cluster, index) => index);
  connectClustersByGeometryComponent(clusters, parents);
  return collectConnectedClusters(clusters, parents);
}

function buildMorphologyClusters(
  rows: readonly PageEvidenceRow[],
): PageEvidenceRow[][] {
  const rowByBlockId = new Map(
    rows.map((row) => [row.inference.blockId, row] as const),
  );
  return clusterAutomaticFontPrintedRows(
    rows.map(({ inference }) => inference),
  ).map((cluster) =>
    cluster
      .map((inference) => rowByBlockId.get(inference.blockId))
      .filter(isDefined),
  );
}

function connectClustersByGeometryComponent(
  clusters: readonly PageEvidenceRow[][],
  parents: number[],
): void {
  const clusterByComponent = new Map<number, number>();
  for (
    let clusterIndex = 0;
    clusterIndex < clusters.length;
    clusterIndex += 1
  ) {
    connectClusterComponents(
      clusters[clusterIndex] ?? [],
      clusterIndex,
      clusterByComponent,
      parents,
    );
  }
}

function connectClusterComponents(
  rows: readonly PageEvidenceRow[],
  clusterIndex: number,
  clusterByComponent: Map<number, number>,
  parents: number[],
): void {
  for (const row of rows) {
    if (row.geometryComponentId === null) continue;
    const existing = clusterByComponent.get(row.geometryComponentId);
    if (existing === undefined) {
      clusterByComponent.set(row.geometryComponentId, clusterIndex);
    } else {
      union(parents, existing, clusterIndex);
    }
  }
}

function collectConnectedClusters(
  clusters: readonly PageEvidenceRow[][],
  parents: number[],
): PageEvidenceRow[][] {
  const connected = new Map<number, PageEvidenceRow[]>();
  for (let index = 0; index < clusters.length; index += 1) {
    const root = find(parents, index);
    const target = connected.get(root) ?? [];
    target.push(...(clusters[index] ?? []));
    connected.set(root, target);
  }
  return [...connected.values()];
}

function applyBodyClusterPlan(
  states: Map<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): void {
  const family = rows[0]?.family;
  if (!family) return;
  const seedRows = rows.filter(
    (row) => row.strongBodySeed && row.directBodyFamily === family,
  );
  if (seedRows.length < MINIMUM_PAGE_ANCHOR_SEED_COUNT) {
    applyUnanchoredBodyRows(states, rows, family);
    return;
  }
  const anchor = selectAutomaticFontPageAnchor(
    seedRows.map(({ inference }) => inference),
    family,
  );
  if (!anchor) {
    applyUnanchoredBodyRows(states, rows, family);
    return;
  }
  for (const row of rows) {
    applyAnchoredBodyRow(states, rows.length, row, family, anchor);
  }
}

type PageAnchor = NonNullable<ReturnType<typeof selectAutomaticFontPageAnchor>>;

function applyAnchoredBodyRow(
  states: Map<string, AutomaticFontPageConsistencyState>,
  clusterSize: number,
  row: PageEvidenceRow,
  family: AutomaticFontPrintedFamily,
  anchor: PageAnchor,
): void {
  if (!hasEligibleAnchor(row, anchor.fontId)) {
    states.set(
      row.inference.blockId,
      resolveIneligibleAnchorState(row, family),
    );
    return;
  }
  states.set(row.inference.blockId, {
    mode: clusterSize >= 2 ? "page_anchor" : "stable_body",
    anchorFontId: anchor.fontId,
    anchorEvidenceCount: anchor.evidenceCount,
    anchorSupportShare: anchor.supportShare,
    printedFamily: family,
    recoveredBody: row.recoveredBody,
    geometryComponentForced: row.geometryComponentForced,
    dohyeonMorphologyVeto: row.dohyeonMorphologyVeto,
  });
}

function hasEligibleAnchor(row: PageEvidenceRow, fontId: string): boolean {
  return row.inference.localEvidence.rankedCandidates.some(
    (candidate) =>
      candidate.fontId === fontId &&
      isAutomaticFontPageTransferEligible(candidate),
  );
}

function resolveIneligibleAnchorState(
  row: PageEvidenceRow,
  family: AutomaticFontPrintedFamily,
): AutomaticFontPageConsistencyState {
  if (row.recoveredBody && !row.strongBodySeed && !row.dohyeonMorphologyVeto) {
    return localVariantState(false);
  }
  return localStableBodyState(row, family);
}

function applyUnanchoredBodyRows(
  states: Map<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
  family: AutomaticFontPrintedFamily,
): void {
  for (const row of rows) {
    states.set(row.inference.blockId, resolveUnanchoredBodyState(row, family));
  }
}

function resolveUnanchoredBodyState(
  row: PageEvidenceRow,
  family: AutomaticFontPrintedFamily,
): AutomaticFontPageConsistencyState {
  if (row.geometryComponentForced && row.geometryComponentAnchorFontId) {
    return {
      mode: "page_anchor",
      anchorFontId: row.geometryComponentAnchorFontId,
      anchorEvidenceCount: row.geometryComponentEvidenceCount,
      anchorSupportShare: 1,
      printedFamily: family,
      recoveredBody: true,
      geometryComponentForced: true,
      dohyeonMorphologyVeto: row.dohyeonMorphologyVeto,
    };
  }
  return resolveIneligibleAnchorState(row, family);
}

function localStableBodyState(
  row: PageEvidenceRow,
  family: AutomaticFontPrintedFamily,
): AutomaticFontPageConsistencyState {
  const localAnchor = resolveBestEligibleBodyCandidate(row.inference, family);
  return {
    mode: "stable_body",
    ...(localAnchor ? { anchorFontId: localAnchor.fontId } : {}),
    anchorEvidenceCount: localAnchor ? 1 : 0,
    anchorSupportShare: localAnchor ? 1 : 0,
    printedFamily: family,
    recoveredBody: row.recoveredBody,
    geometryComponentForced: row.geometryComponentForced,
    dohyeonMorphologyVeto: row.dohyeonMorphologyVeto,
  };
}

function localVariantState(
  dohyeonMorphologyVeto: boolean,
): AutomaticFontPageConsistencyState {
  return {
    mode: "local_visual_variant",
    anchorEvidenceCount: 0,
    ...(dohyeonMorphologyVeto ? { dohyeonMorphologyVeto: true } : {}),
  };
}
