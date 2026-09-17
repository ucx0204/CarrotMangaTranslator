import { hashStableValue } from "../../shared/blockFingerprint";
import {
  CharacterProfileSchema,
  GlossaryEntrySchema,
} from "../../shared/ipcWorkContextSchemas";
import {
  McpExternalResearchSchema,
  type McpContextPreview,
} from "../../shared/mcpContextEditing";
import {
  applyWorkContextResearchOperations,
  createWorkContextResearchFingerprint,
} from "../../shared/workContextResearchProposal";
import type {
  WorkContextResearchOperation,
  WorkContextResearchProposal,
} from "../../shared/workContextResearchTypes";
import type { WorkStyleGuide } from "../../shared/workContextTypes";
import { McpEditError } from "./mcpEditPolicy";

/** Reuse the application's reviewed-operation semantics, then expose only fields
 * accepted by the explicit editor. Research cannot author story memories. */
export function contextResearchChanges(
  guide: WorkStyleGuide,
  result: WorkContextResearchProposal,
  target: Omit<McpContextPreview, "changes">,
) {
  if (result.baseFingerprint !== createWorkContextResearchFingerprint(guide))
    throw new McpEditError(
      "revision_conflict",
      "Research result does not match the requested guide snapshot.",
    );
  if (!Array.isArray(result.operations) || result.operations.length > 100)
    throw new McpEditError(
      "invalid_edit",
      "Research produced too many changes for one review. Nothing was applied.",
    );
  const seen = new Set<string>();
  for (const operation of result.operations)
    validateOperation(guide, operation, seen);
  const reviewed = applyWorkContextResearchOperations(guide, result.operations);
  if (!result.operations.length) return null;
  const parsed = McpExternalResearchSchema.safeParse({
    ...target,
    changes: result.operations.map((operation, index) => ({
      change: {
        changeId: `research-${index + 1}`,
        entity: operation.entity,
        ...(operation.before ? { entryId: operation.before.id } : {}),
        values: editableValues(reviewed, operation),
      },
      reason: operation.reason,
      sources: operation.sources,
    })),
  });
  if (!parsed.success)
    throw new McpEditError(
      "invalid_edit",
      "Research changes or evidence exceed the context review contract. Nothing was applied.",
    );
  return {
    input: {
      ...target,
      changes: parsed.data.changes.map((item) => item.change),
    },
    evidence: parsed.data.changes.map((item) => ({
      changeId: item.change.changeId,
      reason: item.reason,
      sources: item.sources,
    })),
  };
}

function validateOperation(
  guide: WorkStyleGuide,
  operation: WorkContextResearchOperation,
  seen: Set<string>,
): void {
  const key = `${operation.entity}:${operation.after.id}`;
  if (seen.has(key))
    throw new McpEditError(
      "invalid_edit",
      "Research contains duplicate targets.",
    );
  seen.add(key);
  const checked =
    operation.entity === "glossary"
      ? GlossaryEntrySchema.safeParse(operation.after)
      : CharacterProfileSchema.safeParse(operation.after);
  if (!checked.success)
    throw new McpEditError("invalid_edit", "Invalid research entry.");
  const entries =
    operation.entity === "glossary" ? guide.glossary : guide.characters;
  const matches = entries.filter((entry) => entry.id === operation.after.id);
  if (operation.action === "add") {
    if (operation.before || matches.length)
      throw new McpEditError(
        "invalid_edit",
        "Research addition collides with an existing entry.",
      );
  } else if (
    !operation.before ||
    operation.before.id !== operation.after.id ||
    matches.length !== 1 ||
    hashStableValue(matches[0]) !== hashStableValue(operation.before)
  ) {
    throw new McpEditError(
      "revision_conflict",
      "Research update does not match the existing entry.",
    );
  }
  if (
    !["add", "update", "disable"].includes(operation.action) ||
    (operation.action === "disable" && operation.after.enabled !== false)
  )
    throw new McpEditError("invalid_edit", "Inconsistent research action.");
}

function editableValues(
  guide: WorkStyleGuide,
  operation: WorkContextResearchOperation,
): Record<string, unknown> {
  const entry =
    operation.entity === "glossary"
      ? guide.glossary.find((item) => item.id === operation.after.id)!
      : guide.characters.find((item) => item.id === operation.after.id)!;
  const {
    id: _id,
    origin: _origin,
    createdAt: _created,
    updatedAt: _updated,
    ...values
  } = entry;
  return values;
}
