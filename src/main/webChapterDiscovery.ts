import { z } from "zod/v4";
import {
  WebChapterDiscoveryResultSchema,
  type WebChapterDiscoveryRequest,
} from "../shared/webChapterDiscovery";
import { canonicalizeWebImageUrl } from "./webImportUrlPolicy";
import type { WebImportFrame } from "./webImportPageDiscovery";

const payload = z
  .object({
    title: z.string().max(240),
    links: z
      .array(
        z
          .object({
            href: z.string().max(4096),
            label: z.string().max(240),
            position: z.number().int().min(0).max(4999),
          })
          .strict(),
      )
      .max(5000),
    truncated: z.boolean(),
  })
  .strict();

/** Serialized trusted code only; no caller script/selector is executed in the page. */
function collectChapterLinks() {
  const links: Array<{ href: string; label: string; position: number }> = [];
  const clean = (text: string) =>
    text
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 240);
  const walker = document.createTreeWalker(
    document.documentElement,
    NodeFilter.SHOW_ELEMENT,
  );
  let visited = 0;
  let position = 0;
  let node: Node | null;
  while ((node = walker.nextNode()) && visited++ < 20000) {
    if (!(node instanceof HTMLAnchorElement) || !node.hasAttribute("href"))
      continue;
    if (position >= 5000)
      return { title: clean(document.title), links, truncated: true };
    const href = node.href;
    links.push({
      href: href.length <= 4096 ? href : "",
      label: clean(node.textContent ?? ""),
      position,
    });
    position++;
  }
  return { title: clean(document.title), links, truncated: node !== null };
}
export const WEB_CHAPTER_LINKS_SCRIPT = `(${collectChapterLinks.toString()})()`;

export async function discoverChapterLinks(
  frame: WebImportFrame,
  finalUrl: URL,
  request: Pick<WebChapterDiscoveryRequest, "maxLinks" | "pathPrefix">,
) {
  const raw = payload.parse(
    await frame.executeJavaScript(WEB_CHAPTER_LINKS_SCRIPT),
  );
  const skipped = { invalid: 0, offOrigin: 0, duplicate: 0, filtered: 0 };
  const seen = new Set<string>([finalUrl.href]);
  const links: Array<{ url: string; label: string; position: number }> = [];
  let truncated = raw.truncated;
  for (const item of raw.links) {
    const url = canonicalizeWebImageUrl(item.href);
    if (!url) {
      skipped.invalid++;
      continue;
    }
    const parsed = new URL(url);
    if (parsed.origin !== finalUrl.origin) {
      skipped.offOrigin++;
      continue;
    }
    if (request.pathPrefix && !parsed.pathname.startsWith(request.pathPrefix)) {
      skipped.filtered++;
      continue;
    }
    if (seen.has(url)) {
      skipped.duplicate++;
      continue;
    }
    seen.add(url);
    if (links.length >= request.maxLinks) {
      truncated = true;
      continue;
    }
    links.push({ url, label: item.label, position: item.position });
  }
  return WebChapterDiscoveryResultSchema.parse({
    pageUrl: finalUrl.href,
    pageTitle: raw.title,
    links,
    examined: raw.links.length,
    skipped,
    truncated,
    exhaustive: false,
  });
}
