import { z } from "zod";
import { oauthDigest, readChatGptRedirect, readOAuthScope } from "./mcpOAuthPolicy";

const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const client = z.object({
  name: z.string().min(1).max(120),
  redirects: z.array(z.string().transform(readChatGptRedirect)).min(1).max(4),
  method: z.enum(["none", "client_secret_post", "client_secret_basic"]),
  secretHash: digest.optional(),
}).strict().refine((value) => (value.method === "none") === (value.secretHash === undefined), "Client authentication metadata is inconsistent.");
const grant = z.object({
  id: z.string().uuid(), clientId: digest,
  scope: z.string().transform((value) => readOAuthScope(value, true, true)),
  resource: z.string().max(2048), expiresAt: timestamp,
  revoked: z.boolean(), createdAt: timestamp,
}).strict();
function entries<T extends z.ZodTypeAny>(value: T, maximum: number) {
  return z.array(z.object({ digest, expiresAt: timestamp, value }).strict()).max(maximum);
}
const snapshot = z.object({
  version: z.literal(1), issuer: z.string().url().max(2048),
  clients: entries(client, 64), grants: z.array(grant).max(256),
  access: entries(z.string().uuid(), 8192),
  refresh: entries(z.object({ grantId: z.string().uuid(), used: z.boolean() }).strict(), 8192),
}).strict();
export type McpOAuthSnapshot = z.infer<typeof snapshot>;
export type McpOAuthGrant = McpOAuthSnapshot["grants"][number];

/** Validate the complete reference graph before replacing any live state. */
export function parseMcpOAuthSnapshot(value: unknown, issuer: string): McpOAuthSnapshot {
  const result = snapshot.parse(value);
  if (result.issuer !== issuer)
    throw new Error("OAuth resource changed. Existing approvals cannot be transferred.");
  const clients = uniqueKeys(result.clients.map((item) => item.digest));
  const grants = uniqueKeys(result.grants.map((item) => item.id));
  uniqueKeys(result.access.map((item) => item.digest));
  uniqueKeys(result.refresh.map((item) => item.digest));
  for (const item of result.grants) {
    if (!clients.has(oauthDigest(item.clientId)) || item.resource !== `${issuer}/mcp`)
      throw new Error("The saved OAuth grant has an invalid client or audience.");
  }
  for (const item of result.access)
    if (!grants.has(item.value)) throw new Error("Unknown saved OAuth access grant.");
  for (const item of result.refresh)
    if (!grants.has(item.value.grantId)) throw new Error("Unknown saved OAuth refresh grant.");
  return result;
}
function uniqueKeys(keys: string[]): Set<string> {
  const unique = new Set(keys);
  if (unique.size !== keys.length) throw new Error("Duplicate OAuth records are not accepted.");
  return unique;
}
