import { z } from "zod/v4";

export const MCP_EXCHANGE_BYTES = 4 * 1024 * 1024;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const snapshot = z.string().regex(/^[a-f0-9]{16}$/);
const page = z
  .object({
    pageId: id,
    revision: z.string().regex(/^page-v1:[a-f0-9]{16}$/),
  })
  .strict();

export const McpTextExchangeOptionsSchema = z.discriminatedUnion("format", [
  z
    .object({
      format: z.literal("txt"),
      field: z.enum(["both", "translated", "source"]),
      includeHeaders: z.boolean(),
    })
    .strict(),
  z
    .object({
      format: z.enum(["csv", "tsv"]),
      includeBom: z.boolean(),
    })
    .strict(),
]);
export type McpTextExchangeOptions = z.infer<
  typeof McpTextExchangeOptionsSchema
>;

export const McpTextExchangeBindingSchema = z
  .object({
    kind: z.literal("text"),
    workId: id,
    chapterId: id,
    pages: z
      .array(page)
      .min(1)
      .max(50)
      .refine(
        (pages) =>
          new Set(pages.map((page) => page.pageId)).size === pages.length,
        "Select distinct saved pages in native order.",
      ),
    options: McpTextExchangeOptionsSchema,
    direction: z.enum(["ltr", "rtl"]),
    snapshot,
  })
  .strict();
export type McpTextExchangeBinding = z.infer<
  typeof McpTextExchangeBindingSchema
>;

export const McpContextExchangeBindingSchema = z
  .object({
    kind: z.literal("context"),
    workId: id,
    chapterId: id,
    scope: z.enum(["guide", "guide-and-memory"]),
    snapshot,
  })
  .strict();
export type McpContextExchangeBinding = z.infer<
  typeof McpContextExchangeBindingSchema
>;

export const McpExchangeBindingSchema = z.discriminatedUnion("kind", [
  McpTextExchangeBindingSchema,
  McpContextExchangeBindingSchema,
]);
export type McpExchangeBinding = z.infer<typeof McpExchangeBindingSchema>;

export const MCP_EXCHANGE_MIME_TYPES = [
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
] as const;

const formats = {
  txt: { name: "text.txt", mimeType: "text/plain" },
  csv: { name: "review.csv", mimeType: "text/csv" },
  tsv: { name: "review.tsv", mimeType: "text/tab-separated-values" },
  context: { name: "context.json", mimeType: "application/json" },
} as const;

export function mcpExchangeIdentity(binding: McpExchangeBinding) {
  return formats[binding.kind === "text" ? binding.options.format : "context"];
}

export const McpExchangeFileArtifactSchema = z
  .object({
    kind: z.literal("exchange-file"),
    filename: z.enum([
      "carrot-text.txt",
      "carrot-review.csv",
      "carrot-review.tsv",
      "carrot-context.json",
    ]),
    mimeType: z.enum(MCP_EXCHANGE_MIME_TYPES),
    url: z.string().url(),
    bytes: z.number().int().positive().max(MCP_EXCHANGE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().nonnegative(),
    access: z.string().min(1).max(512),
    retainedOutputId: z.string().uuid().optional(),
    exchange: McpExchangeBindingSchema,
    performed: z
      .tuple([z.literal("serialize"), z.literal("export")])
      .optional(),
  })
  .refine((artifact) => {
    const identity = mcpExchangeIdentity(artifact.exchange);
    return (
      artifact.mimeType === identity.mimeType &&
      artifact.filename === `carrot-${identity.name}`
    );
  }, "Exchange file identity does not match its reviewed source.");
