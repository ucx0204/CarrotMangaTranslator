import { z } from "zod";
import { DEFAULT_REDACTION_PREFERENCES } from "../shared/imageRedactionWorkspace";
import type { RedactionWorkspaceDiskState } from "./imageRedactionWorkspaceDiskSchema";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const redactionWorkspaceIndexSchema = z
  .object({
    version: z.literal(2),
    revision: z.number().int().nonnegative(),
    pages: z.record(hash),
    views: z.record(
      z
        .object({ object: hash, touched: z.number().finite().nonnegative() })
        .strict(),
    ),
    preferences: hash,
    presets: hash,
  })
  .strict();
export type RedactionWorkspaceIndex = z.infer<
  typeof redactionWorkspaceIndexSchema
>;
export function emptyRedactionDraft(): RedactionWorkspaceDiskState {
  return {
    version: 1,
    revision: 0,
    pages: {},
    views: {},
    preferences: { ...DEFAULT_REDACTION_PREFERENCES },
    presets: [],
  };
}

/** View positions are a bounded cache; this never expires page masks or reviews. */
export function retainRedactionViews(
  views: RedactionWorkspaceIndex["views"],
): RedactionWorkspaceIndex["views"] {
  return Object.fromEntries(
    Object.entries(views)
      .sort((a, b) => b[1].touched - a[1].touched)
      .slice(0, 1024),
  );
}
