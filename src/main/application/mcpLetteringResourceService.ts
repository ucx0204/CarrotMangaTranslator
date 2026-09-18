import { hashStableValue } from "../../shared/blockFingerprint";
import {
  MCP_LETTERING_RULE_JSON_LIMIT,
  McpLetteringResourceListSchema,
  McpLetteringResourceGetSchema,
  McpLetteringResourceReferenceSchema,
  McpLetteringResourceCommandSchema,
  type McpLetteringResourceReference,
} from "../../shared/mcpLetteringResources";
import {
  ConditionalBatchSchemeDraftV2Schema,
  type ConditionalBatchSchemeDraftV2,
} from "../../shared/conditionalBatchRules";
import type { BlockFormatGroupId } from "../../shared/blockFormat";
import type { BlockStylePresetFormat } from "../../shared/blockStylePresetFormat";
import {
  letteringSchemeIssues,
  type McpLetteringRecipe,
} from "./mcpLetteringProjection";
import { McpEditError } from "./mcpEditPolicy";

export type McpSavedLetteringResource = {
  id: string;
  name: string;
  groupIds: BlockFormatGroupId[];
  format: BlockStylePresetFormat | null;
  advanced: NonNullable<McpLetteringRecipe["advanced"]>;
  schemes: ConditionalBatchSchemeDraftV2[];
  unsupportedReasons: string[];
  /** Only safe source descriptors, never images, paths, credentials or template text. */
  dependencies: { id: string; schemeId: string; enabled: boolean }[];
};
type Read = (
  kind: McpLetteringResourceReference["resourceKind"],
) => Promise<McpSavedLetteringResource[]>;

/** Metadata queries and application resolution have one version authority, with no write port. */
export class McpLetteringResourceService {
  constructor(private readonly read: Read) {}

  async list(value: unknown, guard: () => void) {
    const input = McpLetteringResourceListSchema.parse(value);
    const records = await this.records(input.resourceKind, guard);
    const query = input.query.toLowerCase();
    const snapshot = hashStableValue([
      input.resourceKind,
      query,
      records.map((entry) => entry.summary),
    ]);
    if (
      (input.offset > 0 && !input.snapshot) ||
      (input.snapshot && input.snapshot !== snapshot)
    )
      throw new McpEditError(
        "revision_conflict",
        "Saved lettering resources changed. Restart pagination with a fresh snapshot.",
      );
    const filtered = records.filter(({ summary }) =>
      `${summary.id} ${summary.name}`.toLowerCase().includes(query),
    );
    guard();
    return {
      snapshot,
      ...pageWindow(filtered.length, input.offset, input.limit),
      resources: filtered
        .slice(input.offset, input.offset + input.limit)
        .map((entry) => entry.summary),
    };
  }

  async get(value: unknown, guard: () => void) {
    const input = McpLetteringResourceGetSchema.parse(value);
    const entry = await this.require(input, guard);
    guard();
    return {
      ...entry.summary,
      ...pageWindow(entry.record.schemes.length, input.offset, input.limit),
      formatJson: entry.record.format
        ? JSON.stringify(entry.record.format)
        : null,
      advanced: structuredClone(entry.record.advanced),
      steps: entry.record.schemes
        .slice(input.offset, input.offset + input.limit)
        .map((scheme, offset) => {
          const json = JSON.stringify(scheme);
          return {
            index: input.offset + offset,
            name: scheme.name,
            schemeJson:
              json.length <= MCP_LETTERING_RULE_JSON_LIMIT ? json : null,
          };
        }),
      notes: [
        "read_only_no_resource_or_artwork_write",
        "block_templates_supply_style_only_not_text_geometry_or_images",
        "sequence_contains_enabled_steps_in_saved_order",
        "unsupported_steps_are_never_silently_skipped",
      ],
    };
  }

  async assertCurrent(
    reference: McpLetteringResourceReference,
    guard: () => void,
  ) {
    await this.require(
      McpLetteringResourceReferenceSchema.parse({
        resourceKind: reference.resourceKind,
        id: reference.id,
        snapshot: reference.snapshot,
      }),
      guard,
    );
  }

  async resolve(
    value: unknown,
    guard: () => void,
  ): Promise<McpLetteringRecipe> {
    const command = McpLetteringResourceCommandSchema.parse(value);
    const { record, summary } = await this.require(command, guard);
    if (!summary.supported)
      throw new McpEditError(
        "invalid_edit",
        `Saved resource is not a supported lettering recipe: ${summary.unsupportedReasons.join(", ")}.`,
      );
    if (!record.format) {
      if (command.groupIds)
        throw new McpEditError(
          "invalid_edit",
          "Field groups are only available for presets and block styles.",
        );
      return { schemes: structuredClone(record.schemes) };
    }
    const groups = command.groupIds ?? record.groupIds;
    if (
      new Set(groups).size !== groups.length ||
      groups.some((group) => !record.groupIds.includes(group))
    )
      throw new McpEditError(
        "invalid_edit",
        "Select distinct style groups contained in this saved resource.",
      );
    const scheme = ConditionalBatchSchemeDraftV2Schema.parse({
      name: record.name.slice(0, 80),
      description: "Saved lettering style",
      match: { mode: "allBlocks" },
      actions: [
        {
          id: "saved-style",
          enabled: true,
          type: "applyStylePreset",
          presetName: record.name.slice(0, 80),
          groupIds: groups,
          format: record.format,
        },
      ],
    });
    guard();
    return {
      schemes: [scheme],
      ...(groups.includes("transform")
        ? { advanced: structuredClone(record.advanced) }
        : {}),
    };
  }

  private async require(
    reference: McpLetteringResourceReference,
    guard: () => void,
  ) {
    const entry = (await this.records(reference.resourceKind, guard)).find(
      ({ summary }) => summary.id === reference.id,
    );
    if (!entry)
      throw new McpEditError(
        "not_found",
        "Saved lettering resource no longer exists.",
      );
    if (entry.summary.snapshot !== reference.snapshot)
      throw new McpEditError(
        "revision_conflict",
        "Saved lettering resource or an enabled sequence dependency changed. Read and prepare again.",
      );
    return entry;
  }

  private async records(
    kind: McpLetteringResourceReference["resourceKind"],
    guard: () => void,
  ) {
    guard();
    const source = await this.read(kind);
    guard();
    if (new Set(source.map((entry) => entry.id)).size !== source.length)
      throw new McpEditError(
        "invalid_edit",
        "Saved resource IDs are ambiguous.",
      );
    return source.map((record) => {
      const unsupportedReasons = [
        ...new Set([
          ...record.unsupportedReasons,
          ...record.schemes.flatMap(letteringSchemeIssues),
          ...(record.schemes.some(
            (scheme) =>
              JSON.stringify(scheme).length > MCP_LETTERING_RULE_JSON_LIMIT,
          )
            ? ["rule_exceeds_remote_limit"]
            : []),
        ]),
      ];
      return {
        record,
        summary: {
          resourceKind: kind,
          id: record.id,
          name: record.name,
          groupIds: [...record.groupIds],
          stepCount: record.schemes.length,
          supported: unsupportedReasons.length === 0,
          unsupportedReasons,
          snapshot: hashStableValue([kind, record]),
        },
      };
    });
  }
}
function pageWindow(total: number, offset: number, limit: number) {
  return {
    total,
    offset,
    limit,
    nextOffset: offset + limit < total ? offset + limit : null,
  };
}
