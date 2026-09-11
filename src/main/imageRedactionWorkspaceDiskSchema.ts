import { z } from "zod";
import {
  redactionDecisionSchema,
  redactionDocumentSchema,
  redactionPreferencesSchema,
  redactionPresetSchema,
  redactionViewSchema,
} from "../shared/imageRedactionWorkspace";

export const redactionWorkspaceDiskSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    pages: z.record(
      redactionDocumentSchema
        .omit({ id: true })
        .extend({
          // Read legacy drafts without approving them or discarding their masks.
          decision: z.preprocess(
            (value) => (value === "deferred" ? "unreviewed" : value),
            redactionDecisionSchema,
          ),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .strict(),
    ),
    views: z.record(
      redactionViewSchema.extend({
        filter: z.preprocess(
          (value) => (value === "deferred" ? "unreviewed" : value),
          redactionViewSchema.shape.filter,
        ),
      }),
    ),
    preferences: redactionPreferencesSchema,
    presets: z.array(redactionPresetSchema).max(30),
  })
  .strict();
export type RedactionWorkspaceDiskState = z.infer<
  typeof redactionWorkspaceDiskSchema
>;
