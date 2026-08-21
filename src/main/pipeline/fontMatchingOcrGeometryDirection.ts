import type {
  FontMatchingOcrCandidateMembershipV2,
  OverlayItem,
} from "./types";

export const FONT_MATCHING_OCR_GEOMETRY_DIRECTION_CONTRACT_VERSION =
  "font-matching-ocr-geometry-direction-v2" as const;
const FONT_MATCHING_OCR_CANDIDATE_MEMBERSHIP_CONTRACT_VERSION =
  "font-matching-ocr-candidate-membership-v2" as const;
const FIXED_BLOCK_TRANSLATION_MEMBERSHIP_VERSION = 6;
type FixedBlockMembershipSource = Extract<
  FontMatchingOcrCandidateMembershipV2["source"],
  `semantic_ocr_fixed_block_request_v${number}`
>;

export type FontMatchingOcrGeometryDirectionV2 = Readonly<{
  contractVersion: typeof FONT_MATCHING_OCR_GEOMETRY_DIRECTION_CONTRACT_VERSION;
  source: "semantic_ocr_candidate_bbox_majority";
  direction: "horizontal" | "vertical";
  /** OCR candidates that actually voted after the semantic-OCR ruby rule. */
  candidateIds: readonly number[];
  /** Exact code-owned enclosing membership from which the voters were drawn. */
  candidateMembership: FontMatchingOcrCandidateMembershipV2;
}>;

type DirectionItem = Pick<
  OverlayItem,
  "id" | "candidateIds" | "sourceCandidateMembership"
>;
type FixedBlockMembershipBinding = Readonly<{
  blockId: string;
  candidateIds: readonly number[];
  voterCandidateIds: readonly number[];
}>;
type FixedBlockMembershipInventory = Readonly<{
  source: FixedBlockMembershipSource;
  bindings: ReadonlyMap<string, FixedBlockMembershipBinding>;
}>;
type IndexedHint = Readonly<{
  id: number;
  width: number;
  height: number;
}>;

/**
 * Reconstruct the immutable semantic-OCR source direction without consulting
 * translated text, model roles, or the model-authored OverlayItem.direction.
 * Any incomplete or ambiguous candidate inventory abstains for this block.
 */
export function resolveFontMatchingOcrGeometryDirection(
  item: DirectionItem,
  rawHints: unknown,
): FontMatchingOcrGeometryDirectionV2 | undefined {
  const membership = readFontMatchingOcrCandidateMembership(
    item.sourceCandidateMembership,
    item,
  );
  if (!membership || !Array.isArray(rawHints)) return undefined;
  const candidateIds = membership.originalCandidateIds;
  const hints = indexHints(rawHints);
  const members = new Map<number, IndexedHint>();
  for (const candidateId of candidateIds) {
    const matches = hints.get(candidateId);
    if (!matches || matches.length !== 1) return undefined;
    const member = matches[0];
    if (!member) return undefined;
    members.set(candidateId, member);
  }
  const voters: IndexedHint[] = [];
  for (const candidateId of membership.voterCandidateIds) {
    const voter = members.get(candidateId);
    if (!voter) return undefined;
    voters.push(voter);
  }
  const verticalCount = voters.filter(
    ({ width, height }) => height > width * 1.25,
  ).length;
  return {
    contractVersion: FONT_MATCHING_OCR_GEOMETRY_DIRECTION_CONTRACT_VERSION,
    source: "semantic_ocr_candidate_bbox_majority",
    direction: verticalCount * 2 >= voters.length ? "vertical" : "horizontal",
    candidateIds: voters.map(({ id }) => id),
    candidateMembership: membership,
  };
}

/** Runtime/worker boundary validation. Invalid evidence must never regroup rows. */
// eslint-disable-next-line complexity -- every provenance and membership clause is intentionally fail-closed
export function readFontMatchingOcrGeometryDirection(
  value: unknown,
  item: DirectionItem | undefined,
  trustedMembership: unknown,
): FontMatchingOcrGeometryDirectionV2 | null {
  if (!item || !value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const membership = readFontMatchingOcrCandidateMembership(
    record.candidateMembership,
    item,
  );
  const trusted = readFontMatchingOcrCandidateMembership(
    trustedMembership,
    item,
  );
  if (
    record.contractVersion !==
      FONT_MATCHING_OCR_GEOMETRY_DIRECTION_CONTRACT_VERSION ||
    record.source !== "semantic_ocr_candidate_bbox_majority" ||
    (record.direction !== "horizontal" && record.direction !== "vertical") ||
    !Array.isArray(record.candidateIds) ||
    record.candidateIds.length === 0 ||
    !record.candidateIds.every(isPositiveInteger) ||
    new Set(record.candidateIds).size !== record.candidateIds.length ||
    !membership ||
    !trusted ||
    !sameCandidateMembership(membership, trusted) ||
    !sameCandidateOrder(record.candidateIds, membership.voterCandidateIds)
  ) {
    return null;
  }
  return value as FontMatchingOcrGeometryDirectionV2;
}

/**
 * Stamp membership only when the locally built fixed-block request inventory
 * exactly matches one normalized overlay item. General model-output candidate
 * ids have no request-owned binding and therefore remain unmarked.
 */
export function attachFontMatchingFixedBlockCandidateMembership(
  items: readonly OverlayItem[],
  requestBody: unknown,
): OverlayItem[] {
  const inventory = readFixedBlockMembershipInventory(requestBody);
  const cleanItems = items.map(stripCandidateMembership);
  if (!inventory) return cleanItems;
  const itemKeyCounts = countItemMembershipKeys(cleanItems);
  return cleanItems.map((item) => {
    if (!Array.isArray(item.candidateIds)) return item;
    const candidateIds = resolveCandidateIds(item);
    if (!candidateIds || item.id !== Math.min(...candidateIds)) return item;
    const key = candidateMembershipKey(candidateIds);
    const binding = inventory.bindings.get(key);
    if (!binding || itemKeyCounts.get(key) !== 1) return item;
    return {
      ...item,
      sourceCandidateMembership: {
        contractVersion:
          FONT_MATCHING_OCR_CANDIDATE_MEMBERSHIP_CONTRACT_VERSION,
        source: inventory.source,
        bindingId: binding.blockId,
        originalCandidateIds: [...binding.candidateIds],
        voterCandidateIds: [...binding.voterCandidateIds],
      },
    };
  });
}

// eslint-disable-next-line complexity -- membership provenance is validated as one atomic contract
function readFontMatchingOcrCandidateMembership(
  value: unknown,
  item: DirectionItem,
): FontMatchingOcrCandidateMembershipV2 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const itemCandidateIds = resolveCandidateIds(item);
  if (
    !itemCandidateIds ||
    record.contractVersion !==
      FONT_MATCHING_OCR_CANDIDATE_MEMBERSHIP_CONTRACT_VERSION ||
    (record.source !== "semantic_ocr_fixed_block_request_v5" &&
      record.source !== "semantic_ocr_fixed_block_request_v6" &&
      record.source !== "sealed_font_input_request_block_v2") ||
    typeof record.bindingId !== "string" ||
    record.bindingId.length === 0 ||
    !Array.isArray(record.originalCandidateIds) ||
    !sameCandidateOrder(record.originalCandidateIds, itemCandidateIds) ||
    !Array.isArray(record.voterCandidateIds) ||
    !readCandidateIdArray(record.voterCandidateIds) ||
    !isOrderedSubset(record.voterCandidateIds, record.originalCandidateIds)
  ) {
    return null;
  }
  return value as FontMatchingOcrCandidateMembershipV2;
}

// eslint-disable-next-line complexity -- the code-owned fixed-block inventory is validated as one atomic contract
function readFixedBlockMembershipInventory(
  value: unknown,
): FixedBlockMembershipInventory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fixedBlockTranslationVersion = record.fixedBlockTranslationVersion;
  if (
    (fixedBlockTranslationVersion !== 5 &&
      fixedBlockTranslationVersion !==
        FIXED_BLOCK_TRANSLATION_MEMBERSHIP_VERSION) ||
    !Array.isArray(record.fixedBlockIds) ||
    !Array.isArray(record.fixedBlockCandidateIds) ||
    !Array.isArray(record.fixedBlockDirectionVoterCandidateIds) ||
    record.fixedBlockIds.length === 0 ||
    record.fixedBlockIds.length !== record.fixedBlockCandidateIds.length ||
    record.fixedBlockIds.length !==
      record.fixedBlockDirectionVoterCandidateIds.length
  ) {
    return null;
  }
  const inventory = new Map<string, FixedBlockMembershipBinding>();
  const globallySeenCandidateIds = new Set<number>();
  const seenBlockIds = new Set<string>();
  for (const [index, rawBlockId] of record.fixedBlockIds.entries()) {
    const blockId = String(rawBlockId ?? "");
    const candidateIds = readCandidateIdArray(
      record.fixedBlockCandidateIds[index],
    );
    const voterCandidateIds = readCandidateIdArray(
      record.fixedBlockDirectionVoterCandidateIds[index],
    );
    if (
      !/^B\d{3,4}$/u.test(blockId) ||
      seenBlockIds.has(blockId) ||
      !candidateIds ||
      !voterCandidateIds ||
      !isOrderedSubset(voterCandidateIds, candidateIds) ||
      candidateIds.some((candidateId) =>
        globallySeenCandidateIds.has(candidateId),
      )
    ) {
      return null;
    }
    seenBlockIds.add(blockId);
    candidateIds.forEach((candidateId) =>
      globallySeenCandidateIds.add(candidateId),
    );
    const key = candidateMembershipKey(candidateIds);
    if (inventory.has(key)) return null;
    inventory.set(key, { blockId, candidateIds, voterCandidateIds });
  }
  return {
    source:
      fixedBlockTranslationVersion === 5
        ? "semantic_ocr_fixed_block_request_v5"
        : "semantic_ocr_fixed_block_request_v6",
    bindings: inventory,
  };
}

function countItemMembershipKeys(
  items: readonly OverlayItem[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!Array.isArray(item.candidateIds)) continue;
    const candidateIds = resolveCandidateIds(item);
    if (!candidateIds) continue;
    const key = candidateMembershipKey(candidateIds);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function stripCandidateMembership(item: OverlayItem): OverlayItem {
  const { sourceCandidateMembership: _untrusted, ...clean } = item;
  return clean;
}

function readCandidateIdArray(value: unknown): number[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(isPositiveInteger) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return [...value];
}

function candidateMembershipKey(candidateIds: readonly number[]): string {
  return candidateIds.join(",");
}

function sameCandidateOrder(
  value: readonly unknown[],
  expected: readonly number[],
): boolean {
  return (
    value.length === expected.length &&
    value.every((candidateId, index) => candidateId === expected[index])
  );
}

function sameCandidateMembership(
  left: FontMatchingOcrCandidateMembershipV2,
  right: FontMatchingOcrCandidateMembershipV2,
): boolean {
  return (
    left.contractVersion === right.contractVersion &&
    left.source === right.source &&
    left.bindingId === right.bindingId &&
    sameCandidateOrder(left.originalCandidateIds, right.originalCandidateIds) &&
    sameCandidateOrder(left.voterCandidateIds, right.voterCandidateIds)
  );
}

function isOrderedSubset(
  values: readonly unknown[],
  inventory: readonly unknown[],
): boolean {
  let cursor = 0;
  for (const candidateId of inventory) {
    if (candidateId === values[cursor]) cursor += 1;
  }
  return cursor === values.length;
}

function resolveCandidateIds(item: DirectionItem): number[] | null {
  const rawIds = Array.isArray(item.candidateIds)
    ? item.candidateIds
    : [item.id];
  if (
    rawIds.length === 0 ||
    !rawIds.every(isPositiveInteger) ||
    new Set(rawIds).size !== rawIds.length
  ) {
    return null;
  }
  return [...rawIds];
}

function indexHints(
  rawHints: readonly unknown[],
): Map<number, Array<IndexedHint | null>> {
  const hints = new Map<number, Array<IndexedHint | null>>();
  for (const rawHint of rawHints) {
    const id = readHintId(rawHint);
    if (!id) continue;
    const hint = readHint(rawHint);
    const matches = hints.get(id) ?? [];
    matches.push(hint);
    hints.set(id, matches);
  }
  return hints;
}

function readHintId(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = Number((value as Record<string, unknown>).id);
  return isPositiveInteger(id) ? id : null;
}

function readHint(value: unknown): IndexedHint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const hint = value as Record<string, unknown>;
  const id = readHintId(value);
  const x1 = Number(hint.x1);
  const y1 = Number(hint.y1);
  const x2 = Number(hint.x2);
  const y2 = Number(hint.y2);
  if (
    id === null ||
    ![x1, y1, x2, y2].every(Number.isFinite) ||
    x2 <= x1 ||
    y2 <= y1
  ) {
    return null;
  }
  return {
    id,
    width: x2 - x1,
    height: y2 - y1,
  };
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}
