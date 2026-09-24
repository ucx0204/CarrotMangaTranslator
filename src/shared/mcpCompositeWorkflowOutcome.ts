import { z } from "zod/v4";
import {
  McpCompositeFingerprintSchema as fingerprint,
  McpCompositePageSchema,
  McpCompositeChildReferenceSchema,
} from "./mcpCompositeWorkflow";

/** The same bounded native receipt is persisted and exposed in a composite view. */
export const McpCompositeOutcomeSchema = z
  .object({
    status: z.enum([
      "completed",
      "partial",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    receipt: McpCompositeChildReferenceSchema,
    resultFingerprint: fingerprint,
    imported: z
      .object({
        selectionFingerprint: fingerprint,
        items: z
          .array(
            z
              .object({ itemKey: fingerprint, page: McpCompositePageSchema })
              .strict(),
          )
          .min(1)
          .max(50),
      })
      .strict()
      .optional(),
  })
  .strict();
