import { z } from "zod";

const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const expiry = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const mcpGrantSchema = z
  .object({
    id: z.string().uuid(),
    clientId: digest,
    clientName: z.string().max(120),
    scope: z.string().max(200),
    resource: z.string().url().max(2048),
    expiresAt: expiry,
    revoked: z.boolean(),
  })
  .strict();
const client = z
  .object({
    name: z.string().max(120),
    redirects: z.array(z.string().url().max(2048)).min(1).max(4),
    method: z.enum(["none", "client_secret_post", "client_secret_basic"]),
    secretHash: digest.optional(),
  })
  .strict();
const entry = <T extends z.ZodType>(value: T) =>
  z.object({ key: digest, expiresAt: expiry, value }).strict();
export const mcpOAuthSnapshotSchema = z
  .object({
    version: z.literal(1),
    resource: z.string().url().max(2048),
    clients: z.array(entry(client)).max(64),
    access: z.array(entry(mcpGrantSchema)).max(512),
    refresh: z
      .array(
        entry(z.object({ grant: mcpGrantSchema, used: z.boolean() }).strict()),
      )
      .max(512),
  })
  .strict();
export type McpGrant = z.infer<typeof mcpGrantSchema>;
export type McpOAuthSnapshot = z.infer<typeof mcpOAuthSnapshotSchema>;
