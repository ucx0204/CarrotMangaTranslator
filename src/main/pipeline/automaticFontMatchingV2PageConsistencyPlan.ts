import {
  clusterAutomaticFontPrintedRows,
  isAutomaticFontPageTransferEligible,
  selectAutomaticFontPageAnchor,
  type AutomaticFontPrintedFamily,
} from "./automaticFontMatchingV2PageFamily";
import { applyDohyeonDominanceClusterRescues } from "./automaticFontMatchingV2PageConsistencyDohyeonCluster";
import { applyDohyeonMorphologyRecoveryPlans } from "./automaticFontMatchingV2PageConsistencyDohyeonRecoveryPlan";
import { applyDominantOrdinaryRecoveries } from "./automaticFontMatchingV2PageConsistencyDominantOrdinary";
import { applyNeutralHeadEmphasisConsensus } from "./automaticFontMatchingV2PageConsistencyEmphasis";
import { buildInitialEvidenceRow } from "./automaticFontMatchingV2PageConsistencyEvidence";
import { applySplitGeometryComponents } from "./automaticFontMatchingV2PageConsistencyGeometry";
import { applyNeutralHeadOrdinaryConsensus } from "./automaticFontMatchingV2PageConsistencyOrdinary";
import {
  find,
  isDefined,
  resolveBestEligibleBodyCandidate,
  union,
  type AutomaticFontPageConsistencyState,
  type PageEvidenceRow,
  type PageGeometryItem,
} from "./automaticFontMatchingV2PageConsistencyShared";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";

const MINIMUM_PAGE_ANCHOR_SEED_COUNT = 2;

export function buildPageConsistencyPlan(
  inferences: readonly (
    | VerifiedAutomaticFontPixelInferenceV2
    | null
    | undefined
  )[],
  items: readonly PageGeometryItem[],
): ReadonlyMap<string, AutomaticFontPageConsistencyState> {
  const rows = inferences.flatMap((inference, index) =>
    inference ? [buildInitialEvidenceRow(inference, items[index])] : [],
  );
  applySplitGeometryComponents(rows);
  const states = initializeVariantStates(rows);
  applyBodyGroupPlans(states, rows);
  applyNeutralHeadOrdinaryConsensus(states, rows);
  applyDohyeonDominanceClusterRescues(states, rows);
  applyDohyeonMorphologyRecoveryPlans(states, rows);
  applyNeutralHeadEmphasisConsensus(states, rows);
  applyDominantOrdinaryRecoveries(states, rows);
  return states;
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
