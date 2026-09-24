import { z } from "zod";
import { hashStableValue } from "./blockFingerprint";
import {
  ChapterStoryMemorySchema,
  WorkStyleGuideSchema,
} from "./ipcWorkContextSchemas";
import {
  MCP_EXCHANGE_BYTES,
  McpContextExchangeBindingSchema,
  type McpContextExchangeBinding,
} from "./mcpExchangeFiles";

/** The bridge validates the existing Zod-4 binding without composing Zod versions. */
const binding = z.custom<McpContextExchangeBinding>(
  (value) => McpContextExchangeBindingSchema.safeParse(value).success,
);
const payloadSchema = z
  .object({
    format: z.literal("carrot-work-context"),
    version: z.literal(1),
    source: binding,
    guide: WorkStyleGuideSchema.nullable(),
    memory: ChapterStoryMemorySchema.nullable().optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    const source = McpContextExchangeBindingSchema.safeParse(payload.source);
    if (!source.success) return;
    const { workId, chapterId, scope } = source.data;
    if (
      (payload.guide && payload.guide.workId !== workId) ||
      (payload.memory &&
        (payload.memory.workId !== workId ||
          payload.memory.chapterId !== chapterId)) ||
      (scope === "guide"
        ? Object.hasOwn(payload, "memory")
        : payload.memory === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Context payload identity or selected scope does not match.",
      });
  });
export type McpContextExchangePayload = z.infer<typeof payloadSchema>;

export function parseMcpContextExchangePayload(
  value: unknown,
): McpContextExchangePayload {
  const result = payloadSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      "Context JSON does not match the native version-one schemas and declared scope.",
    );
  return result.data;
}

/** No model repair, field clipping, schema replacement or alternate serializer. */
export function encodeMcpContextExchangePayload(
  value: McpContextExchangePayload,
): Uint8Array {
  const payload = parseMcpContextExchangePayload(value);
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  assertContextExchangeBytes(bytes.byteLength);
  return bytes;
}

export function decodeMcpContextExchangePayload(bytes: Uint8Array) {
  assertContextExchangeBytes(bytes.byteLength);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("Context input must be exact UTF-8 JSON without repair.", {
      cause: error,
    });
  }
  const payload = parseMcpContextExchangePayload(raw);
  // Native normalization and pretty JSON can change length: bound both representations.
  const canonicalBytes = encodeMcpContextExchangePayload(payload);
  const nativeNormalization = hashStableValue(raw) !== hashStableValue(payload);
  return { payload, canonicalBytes, nativeNormalization };
}

function assertContextExchangeBytes(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MCP_EXCHANGE_BYTES)
    throw new Error(
      "Context exchange exceeds its four-MiB UTF-8 byte limit; nothing was truncated.",
    );
}
