import { z } from "zod/v4";
import { ALL_BLOCK_FORMAT_GROUP_IDS } from "./blockFormat";
import { McpLetteringAdvancedSchema } from "./mcpLetteringAdvanced";

const kind = z.enum(["preset", "rule", "sequence", "block-style"]);
const id = z.string().min(1).max(200);
const snapshot = z.string().regex(/^[a-f0-9]{16}$/);
const groups = z.array(z.enum(ALL_BLOCK_FORMAT_GROUP_IDS)).min(1).max(13);
export const MCP_LETTERING_RULE_JSON_LIMIT = 100000;
export const McpLetteringResourceReferenceSchema = z.object({
  resourceKind: kind, id, snapshot,
}).strict();
export const McpLetteringResourceCommandSchema = McpLetteringResourceReferenceSchema.extend({
  kind: z.literal("resource"), groupIds: groups.optional(),
}).strict();
export type McpLetteringResourceReference = z.infer<typeof McpLetteringResourceReferenceSchema>;
export type McpLetteringResourceCommand = z.infer<typeof McpLetteringResourceCommandSchema>;
export const McpLetteringResourceListSchema = z.object({
  resourceKind: kind, query: z.string().trim().max(200).default(""),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(25).default(20),
  snapshot: snapshot.optional(),
}).strict();
export const McpLetteringResourceGetSchema = McpLetteringResourceReferenceSchema.extend({
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(5).default(3),
}).strict();
const summary = McpLetteringResourceReferenceSchema.extend({
  name: z.string().min(1).max(200), supported: z.boolean(),
  unsupportedReasons: z.array(z.string().max(200)).max(128),
  groupIds: z.array(z.enum(ALL_BLOCK_FORMAT_GROUP_IDS)).max(13),
  stepCount: z.number().int().nonnegative().max(100),
}).strict();
const window = {
  total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(), nextOffset: z.number().int().nonnegative().nullable(),
};
export const mcpLetteringResourceOutputs = {
  carrot_list_lettering_resources: z.object({ ...window, snapshot, resources: z.array(summary).max(25) }).strict(),
  carrot_get_lettering_resource: summary.extend({
    ...window,
    formatJson: z.string().max(20000).nullable(),
    advanced: McpLetteringAdvancedSchema,
    steps: z.array(z.object({
      index: z.number().int().nonnegative(), name: z.string().max(80),
      schemeJson: z.string().max(MCP_LETTERING_RULE_JSON_LIMIT).nullable(),
    }).strict()).max(5),
    notes: z.array(z.string().max(200)).max(8),
  }).strict(),
};
