import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** Historical selected input, not a claim about current artwork or a whole website. */
export const ImportSourceIdentitySchema = z
  .object({
    version: z.literal(1),
    basis: z.literal("selected-input-bytes"),
    selectionSha256: sha256,
    pageCount: z.number().int().min(1).max(50),
    urlSha256: sha256.optional(),
  })
  .strict();
export type ImportSourceIdentity = z.infer<typeof ImportSourceIdentitySchema>;

export function matchImportSource(
  selected: ImportSourceIdentity,
  historical: ImportSourceIdentity,
): "content-and-url" | "content" | "url" | undefined {
  const content =
    selected.pageCount === historical.pageCount &&
    selected.selectionSha256 === historical.selectionSha256;
  const url = Boolean(
    selected.urlSha256 && selected.urlSha256 === historical.urlSha256,
  );
  if (content && url) return "content-and-url";
  if (content) return "content";
  if (url) return "url";
  return undefined;
}
