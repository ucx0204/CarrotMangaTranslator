import { hashStableValue } from "../../shared/blockFingerprint";
import type {
  CharacterProfile,
  GlossaryEntry,
  WorkStyleGuide,
} from "../../shared/workContextTypes";
import type { McpContextMigrationPreview } from "../../shared/mcpContextMigration";
import type { McpContextReference } from "../../shared/mcpContextReferences";
import { McpEditError } from "./mcpEditPolicy";

type Entry = GlossaryEntry | CharacterProfile;
type Metadata = "origin" | "createdAt" | "updatedAt";
type Draft = Omit<GlossaryEntry, Metadata> | Omit<CharacterProfile, Metadata>;
type Command = McpContextMigrationPreview["command"];
type Catalog = Map<string, Draft>;

/** Identity changes are explicit, never inferred from equal names or research prose.
 * Drafts intentionally contain no storage timestamps or provenance assignments. */
export function planMcpContextCatalogMigration(
  guide: WorkStyleGuide,
  command: Command,
  preserveManual: boolean,
  references: readonly McpContextReference[],
) {
  const entity =
    command.kind === "replace-glossary"
      ? "glossary"
      : command.kind === "replace-characters"
        ? "character"
        : command.entity;
  const entries: Entry[] =
    entity === "glossary" ? guide.glossary : guide.characters;
  const original = uniqueCatalog(entries);
  const before = uniqueCatalog(entries.map(entryFields));
  const { after, mappings } = projectCatalog(
    before,
    command,
    original,
    preserveManual,
  );
  assertManualPreserved(original, after, preserveManual);
  validateMappings(before, after, mappings);
  const affected = references
    .filter((reference) => {
      if (reference.entity !== entity || after.has(reference.entryId))
        return false;
      if (before.has(reference.entryId) && !mappings.has(reference.entryId))
        throw new McpEditError(
          "invalid_edit",
          "Removing a referenced entry requires an explicit destination or unlink mapping, including orphaned memories.",
        );
      return mappings.has(reference.entryId);
    })
    .map((reference) => ({
      ...reference,
      toId: mappings.get(reference.entryId) ?? null,
    }));
  const changes = describeCatalog(entity, before, after);
  const manualEntriesPreserved = entries.filter(
    (entry) =>
      entry.origin !== "ai" &&
      after.has(entry.id) &&
      equal(entryFields(entry), after.get(entry.id)),
  ).length;
  return {
    entity,
    catalog: [...after.values()],
    mappings,
    changes,
    references: affected,
    manualEntriesPreserved,
    catalogOrderChanged: !equal([...before.keys()], [...after.keys()]),
  };
}

function entryFields(entry: Entry): Draft {
  const {
    origin: _origin,
    createdAt: _created,
    updatedAt: _updated,
    ...fields
  } = entry;
  return fields;
}
function equal(a: unknown, b: unknown) {
  return hashStableValue(a) === hashStableValue(b);
}
function uniqueCatalog<T extends { id: string }>(
  entries: readonly T[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const entry of entries) {
    if (result.has(entry.id))
      throw new McpEditError(
        "invalid_edit",
        "Duplicate catalog IDs are ambiguous; resolve them explicitly before migration.",
      );
    result.set(entry.id, entry);
  }
  return result;
}
function requireEntry(catalog: Catalog, id: string): Draft {
  const entry = catalog.get(id);
  if (!entry)
    throw new McpEditError(
      "not_found",
      "A migration source or destination entry does not exist.",
    );
  return entry;
}

function projectCatalog(
  before: Catalog,
  command: Command,
  original: Map<string, Entry>,
  preserveManual: boolean,
) {
  if (
    command.kind === "replace-glossary" ||
    command.kind === "replace-characters"
  )
    return replaceCatalog(command, original, preserveManual);
  const after = new Map(before);
  const mappings = new Map<string, string | null>();
  if (command.kind === "merge") {
    const target = requireEntry(before, command.targetId);
    if (!target.enabled || command.sourceIds.includes(command.targetId))
      throw new McpEditError(
        "invalid_edit",
        "Merge requires an enabled destination distinct from every source.",
      );
    const sources = command.sourceIds.map((id) => requireEntry(before, id));
    for (const source of sources) {
      after.delete(source.id);
      mappings.set(source.id, target.id);
    }
    if (command.copyAliases)
      after.set(target.id, mergeAliases(target, sources));
  } else {
    for (const id of command.entryIds) {
      requireEntry(before, id);
      after.delete(id);
      if (command.unlinkReferences) mappings.set(id, null);
    }
  }
  return { after, mappings };
}

function replaceCatalog(
  command: Extract<
    Command,
    { kind: "replace-glossary" | "replace-characters" }
  >,
  original: Map<string, Entry>,
  preserveManual: boolean,
) {
  const after: Catalog = uniqueCatalog<Draft>(command.entries);
  if (preserveManual)
    for (const entry of original.values())
      if (entry.origin !== "ai" && !after.has(entry.id))
        after.set(entry.id, entryFields(entry));
  const mappings = new Map<string, string | null>();
  for (const mapping of command.mappings) {
    if (mappings.has(mapping.fromId))
      throw new McpEditError(
        "invalid_edit",
        "Each removed ID requires at most one explicit mapping.",
      );
    mappings.set(mapping.fromId, mapping.toId);
  }
  return { after, mappings };
}

function assertManualPreserved(
  original: Map<string, Entry>,
  after: Catalog,
  preserve: boolean,
) {
  if (!preserve) return;
  for (const entry of original.values()) {
    if (entry.origin === "ai") continue;
    const next = after.get(entry.id);
    if (!next || !equal(entryFields(entry), next))
      throw new McpEditError(
        "invalid_edit",
        "Manual or legacy entries are protected. Explicitly set preserveManual=false to change or remove them.",
      );
  }
}

function validateMappings(
  before: Catalog,
  after: Catalog,
  mappings: Map<string, string | null>,
) {
  for (const [fromId, toId] of mappings) {
    if (!before.has(fromId) || after.has(fromId))
      throw new McpEditError(
        "invalid_edit",
        "Map only existing entries actually removed by this migration; retained manual entries cannot be remapped.",
      );
    if (toId !== null && !after.get(toId)?.enabled)
      throw new McpEditError(
        "invalid_edit",
        "A mapping must name an enabled surviving entry of the same kind. Chains and cycles are not accepted.",
      );
  }
}

function mergeAliases(target: Draft, sources: Draft[]): Draft {
  const aliases = new Set(target.aliases ?? []);
  for (const entry of sources) {
    const names =
      "source" in entry
        ? [entry.source]
        : [entry.displayName, ...entry.sourceNames];
    for (const alias of [...names, ...(entry.aliases ?? [])])
      aliases.add(alias);
  }
  if (aliases.size > 50 || [...aliases].some((alias) => alias.length > 200))
    throw new McpEditError(
      "invalid_edit",
      "Merged aliases exceed native limits; choose aliases explicitly instead of truncating them.",
    );
  return { ...target, aliases: [...aliases] };
}

function describeCatalog(
  entity: "character" | "glossary",
  before: Catalog,
  after: Catalog,
) {
  const changes = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(id) ?? null;
    const next = after.get(id) ?? null;
    if (equal(previous, next)) continue;
    const operation =
      previous === null
        ? ("added" as const)
        : next === null
          ? ("removed" as const)
          : ("updated" as const);
    changes.push({
      entity,
      entryId: id,
      operation,
      before: previous,
      after: next,
    });
  }
  return changes;
}
