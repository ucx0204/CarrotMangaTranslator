import { z } from "zod/v4";

const count = z.number().int().nonnegative();
const publicUrl = z
  .string()
  .max(4096)
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  }, "Expected an HTTP(S) URL without credentials or fragment.");
export const WebChapterDiscoveryRequestSchema = z
  .object({
    requestId: z.uuid(),
    url: z.string().min(1).max(4096),
    pathPrefix: z
      .string()
      .max(1024)
      .regex(/^\/[^?#\u0000-\u001f\u007f]*$/)
      .optional(),
    maxLinks: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export type WebChapterDiscoveryRequest = z.infer<
  typeof WebChapterDiscoveryRequestSchema
>;
export const WebChapterLinkSchema = z
  .object({
    url: publicUrl,
    label: z.string().max(240),
    position: count.max(4999),
  })
  .strict();
export const WebChapterDiscoveryResultSchema = z
  .object({
    pageUrl: publicUrl,
    pageTitle: z.string().max(240),
    links: z.array(WebChapterLinkSchema).max(200),
    examined: count.max(5000),
    skipped: z
      .object({
        invalid: count,
        offOrigin: count,
        duplicate: count,
        filtered: count,
      })
      .strict(),
    truncated: z.boolean(),
    exhaustive: z.literal(false),
  })
  .strict()
  .refine((value) => {
    if (!URL.canParse(value.pageUrl)) return false;
    const origin = new URL(value.pageUrl).origin;
    return (
      new Set(value.links.map((link) => link.url)).size ===
        value.links.length &&
      value.links.every(
        (link) =>
          URL.canParse(link.url) &&
          new URL(link.url).origin === origin &&
          link.url !== value.pageUrl,
      )
    );
  }, "Discovered links must be distinct same-origin candidates, not the source page.");
export type WebChapterDiscoveryResult = z.infer<
  typeof WebChapterDiscoveryResultSchema
>;
