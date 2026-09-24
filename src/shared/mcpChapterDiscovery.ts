import { z } from "zod/v4";
import {
  WebChapterDiscoveryRequestSchema,
  WebChapterDiscoveryResultSchema,
  WebChapterLinkSchema,
} from "./webChapterDiscovery";
import { mcpRetentionOutputs } from "./mcpRetention";

const count = z.number().int().nonnegative();
const snapshot = z.string().regex(/^[a-f0-9]{16}$/);
export const McpDiscoverChaptersSchema =
  WebChapterDiscoveryRequestSchema.extend({
    allowNetwork: z.literal(true),
  }).strict();
export type McpDiscoverChapters = z.infer<typeof McpDiscoverChaptersSchema>;
export const McpChapterDiscoveryGetSchema = z
  .object({
    id: z.uuid(),
    snapshot: snapshot.optional(),
    offset: count.default(0),
    limit: count.min(1).max(25).default(25),
  })
  .strict();
export const McpDiscoveredChapterScanSchema = z
  .object({
    requestId: z.uuid(),
    id: z.uuid(),
    snapshot,
    linkId: z.uuid(),
    allowNetwork: z.literal(true),
  })
  .strict();
export const McpChapterDiscoveryReferenceSchema = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    snapshot,
    linkCount: count.max(200),
    expiresAt: count,
    retention: z.literal("seven-days"),
    availability: z.literal("lookup-required"),
  })
  .strict();
const McpDiscoveredLinkSchema = WebChapterLinkSchema.extend({
  id: z.uuid(),
}).strict();
const catalog = mcpRetentionOutputs.carrot_list_context_proposals;
export const mcpChapterDiscoveryOutputs = {
  carrot_get_chapter_discovery: z
    .object({
      ...McpChapterDiscoveryReferenceSchema.shape,
      ...WebChapterDiscoveryResultSchema.shape,
      links: z.array(McpDiscoveredLinkSchema).max(25),
      total: count.max(200),
      offset: count,
      limit: count,
      nextOffset: count.nullable(),
      warnings: z.array(z.string().max(1000)).max(5),
    })
    .strict(),
  carrot_list_chapter_discoveries: catalog.extend({
    items: z
      .array(
        catalog.shape.items.element.extend({
          kind: z.literal("chapter-discovery"),
        }),
      )
      .max(25),
  }),
};
