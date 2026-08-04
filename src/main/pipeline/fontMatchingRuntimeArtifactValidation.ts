import {
  FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA,
  FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2,
} from "./fontMatchingRuntimeArtifactContract";

const HYBRID_VARIANT_ROLES = [
  "whisper",
  "aside_balloon_edge",
  "emphasis_dialogue",
  "shout",
  "sfx_impact",
  "sfx_motion",
  "sfx_ambient",
  "sfx_emotion",
  "sfx_comic",
  "sign_ui_title",
  "other",
] as const;

export function validHybridRoutingForSchema(
  contract: Record<string, unknown>,
): boolean {
  if (contract.schema_version === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA) {
    return contract.hybrid_score_routing === undefined;
  }
  if (contract.schema_version !== FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2) {
    return false;
  }
  return (
    validHybridRouting(recordAt(contract, "hybrid_score_routing")) &&
    validHybridBatching(recordAt(contract, "runtime_batching"))
  );
}

function validHybridRouting(routing: Record<string, unknown> | null): boolean {
  if (!routing) return false;
  return [
    routing.schema_version === "font-matching-hybrid-score-routing-v1",
    routing.candidate_scores_compatibility_alias === "body_candidate_scores",
    routing.body_candidate_output === "body_candidate_scores",
    routing.variant_candidate_output === "variant_candidate_scores",
    sameCandidateOrder(stringArrayAt(routing, "body_roles") ?? [], [
      "dialogue",
      "narration",
      "thought",
    ]),
    sameCandidateOrder(
      stringArrayAt(routing, "variant_roles") ?? [],
      HYBRID_VARIANT_ROLES,
    ),
    routing.unknown_role_fallback === "variant_candidate_scores",
    routing.role_source ===
      "resolveCombinedAutomaticFontRole(item.fontRole,pixelRole)",
    routing.selection_feature_source ===
      "selected_candidate_scores_with_legacy256_visual_features",
    routing.selection_feature_dim === 256,
    routing.row_specific_rules === false,
  ].every(Boolean);
}

function validHybridBatching(
  batching: Record<string, unknown> | null,
): boolean {
  if (!batching) return false;
  return [
    batching.encoder_batch_size === 2,
    batching.ranker_batch_size === 16,
    batching.parity_qualified === true,
  ].every(Boolean);
}

export function sameCandidateOrder(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordAt(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const selected = value[key];
  return isRecord(selected) ? selected : null;
}

export function stringArrayAt(
  value: Record<string, unknown>,
  key: string,
): readonly string[] | null {
  const selected = value[key];
  return Array.isArray(selected) &&
    selected.every((entry) => typeof entry === "string")
    ? selected
    : null;
}

export function textAt(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const selected = value[key];
  return typeof selected === "string" && selected.trim().length > 0
    ? selected
    : null;
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isProbability(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}
