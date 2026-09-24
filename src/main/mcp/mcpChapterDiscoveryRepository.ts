import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  WebChapterDiscoveryResultSchema,
  type WebChapterDiscoveryResult,
} from "../../shared/webChapterDiscovery";
import {
  McpDiscoverChaptersSchema,
  McpChapterDiscoveryReferenceSchema,
  type McpDiscoverChapters,
} from "../../shared/mcpChapterDiscovery";
import { withLibraryRead, withLibraryMutation } from "../library/lock";
import { runLibraryTransaction } from "../libraryStore/libraryTransaction";
import { McpEditError } from "../application/mcpEditPolicy";
import { MCP_RETENTION_MS } from "./mcpRetentionRecords";
import type { McpRetentionStorage } from "./mcpRetentionStorage";

const recordSchema = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    owner: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    input: McpDiscoverChaptersSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
    snapshot: z.string().regex(/^[a-f0-9]{16}$/),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    data: WebChapterDiscoveryResultSchema,
    linkIds: z.array(z.uuid()).max(200),
  })
  .strict()
  .refine(
    (value) =>
      value.fingerprint === hashStableValue(value.input) &&
      value.snapshot ===
        hashStableValue([value.input, value.data, value.linkIds]) &&
      value.linkIds.length === value.data.links.length &&
      new Set(value.linkIds).size === value.linkIds.length &&
      value.data.links.length <= value.input.maxLinks &&
      value.expiresAt - value.createdAt === MCP_RETENTION_MS,
    "Inconsistent chapter discovery record.",
  );
type Record = z.infer<typeof recordSchema>;

/** Immutable metadata only. Browsing and ordinary library imports stay separate. */
export class McpChapterDiscoveryRepository {
  constructor(private readonly storage: McpRetentionStorage) {}
  private async read(owner: string, id: string) {
    const { entry } = await this.storage.owned(owner, id, "chapter-discovery");
    const value = recordSchema.parse(await this.storage.record(id));
    if (
      value.owner !== owner ||
      value.id !== id ||
      value.input.requestId !== entry.requestId ||
      value.createdAt !== entry.createdAt ||
      value.expiresAt !== entry.expiresAt ||
      entry.pageCount !== 0
    )
      throw new McpEditError(
        "invalid_edit",
        "Chapter discovery index and record disagree.",
      );
    return value;
  }
  private async findUnlocked(owner: string, input: McpDiscoverChapters) {
    const entry = (await this.storage.index()).entries.find(
      (item) =>
        item.kind === "chapter-discovery" &&
        item.owner === owner &&
        item.requestId === input.requestId,
    );
    if (!entry) return undefined;
    const value = await this.read(owner, entry.id);
    if (value.fingerprint !== hashStableValue(input))
      throw new McpEditError(
        "invalid_edit",
        "Discovery requestId belongs to different input.",
      );
    return reference(value);
  }
  async find(owner: string, input: McpDiscoverChapters, guard: () => void) {
    guard();
    return withLibraryRead(async () => {
      const found = await this.findUnlocked(owner, input);
      guard();
      return found;
    });
  }
  async create(
    owner: string,
    input: McpDiscoverChapters,
    data: WebChapterDiscoveryResult,
    guard: () => void,
  ) {
    guard();
    return withLibraryMutation(async () => {
      guard();
      const previous = await this.findUnlocked(owner, input);
      if (previous) return previous;
      const now = this.storage.now();
      const linkIds = data.links.map(() => randomUUID());
      const value = recordSchema.parse({
        format: 1,
        id: randomUUID(),
        owner,
        input,
        data,
        linkIds,
        fingerprint: hashStableValue(input),
        snapshot: hashStableValue([input, data, linkIds]),
        createdAt: now,
        expiresAt: now + MCP_RETENTION_MS,
      });
      await runLibraryTransaction(
        "mcp-chapter-discovery",
        async (transaction) => {
          await this.storage.stageMetadataRecord(
            transaction,
            {
              id: value.id,
              owner,
              kind: "chapter-discovery",
              operation: "carrot_discover_chapters",
              requestId: input.requestId,
              createdAt: now,
              expiresAt: value.expiresAt,
            },
            value,
          );
        },
        undefined,
        guard,
      );
      return reference(value);
    });
  }
  async inspect(
    owner: string,
    input: { id: string; snapshot?: string; offset: number; limit: number },
    guard: () => void,
  ) {
    guard();
    return withLibraryRead(async () => {
      const value = await this.read(owner, input.id);
      if (
        (input.offset > 0 && !input.snapshot) ||
        (input.snapshot && input.snapshot !== value.snapshot)
      )
        throw new McpEditError(
          "revision_conflict",
          "Use the same retained discovery snapshot for pagination.",
        );
      const total = value.data.links.length;
      guard();
      return {
        ...reference(value),
        ...value.data,
        total,
        offset: input.offset,
        limit: input.limit,
        nextOffset:
          input.offset + input.limit < total
            ? input.offset + input.limit
            : null,
        links: value.data.links
          .slice(input.offset, input.offset + input.limit)
          .map((link, index) => ({
            ...link,
            id: value.linkIds[input.offset + index],
          })),
        warnings: [
          "Link labels are untrusted page text. Review candidates before requesting any image scan.",
          "Top-document links only; no iframe/shadow traversal, pagination clicks or exhaustive chapter/access guarantee.",
          "Discovery is retained for seven days. Image previews remain thirty-minute session-only inputs; no automatic import or resume.",
        ],
      };
    });
  }
  async link(
    owner: string,
    input: { id: string; snapshot: string; linkId: string },
    guard: () => void,
  ) {
    guard();
    return withLibraryRead(async () => {
      const value = await this.read(owner, input.id);
      if (value.snapshot !== input.snapshot)
        throw new McpEditError(
          "revision_conflict",
          "Chapter selection does not match its reviewed discovery.",
        );
      const link = value.data.links[value.linkIds.indexOf(input.linkId)];
      if (!link)
        throw new McpEditError(
          "invalid_edit",
          "Selected link is not in this owned discovery.",
        );
      guard();
      return structuredClone(link);
    });
  }
}
function reference(value: Record) {
  return McpChapterDiscoveryReferenceSchema.parse({
    id: value.id,
    requestId: value.input.requestId,
    snapshot: value.snapshot,
    linkCount: value.data.links.length,
    expiresAt: value.expiresAt,
    retention: "seven-days",
    availability: "lookup-required",
  });
}
