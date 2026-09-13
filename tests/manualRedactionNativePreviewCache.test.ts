import { expect, it } from "vitest";
import { RedactionPreviewCache } from "../src/renderer/src/components/imageRedaction/redactionPreviewCache";
import type { RedactionPreviewRequest } from "../src/shared/imageRedactionWorkspace";

const overview: RedactionPreviewRequest = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  pageId: "page",
  maxEdge: 2048,
};
const tile = {
  ...overview,
  region: { x: 64, y: 128, width: 512, height: 256 },
} satisfies RedactionPreviewRequest;

it("separates overview and crop variants while deduplicating equal pending tiles", async () => {
  const started: RedactionPreviewRequest[] = [];
  const releases: ((url: string) => void)[] = [];
  const cache = new RedactionPreviewCache((input) => {
    started.push(input);
    return new Promise<string>((resolve) => releases.push(resolve));
  });
  const a = cache.read(overview);
  const b = cache.read(tile, true);
  const c = cache.read({ ...tile, region: { ...tile.region, x: 576 } }, true);
  expect(cache.read({ ...tile, region: { ...tile.region } }, true)).toBe(b);
  expect(started).toHaveLength(3);
  releases.forEach((release, index) => release(`image-${index}`));
  await expect(Promise.all([a, b, c])).resolves.toEqual([
    "image-0",
    "image-1",
    "image-2",
  ]);
  await expect(cache.read(tile)).resolves.toBe("image-1");
  cache.dispose();
});

it("invalidates every native crop with the page without evicting unrelated pages", async () => {
  let calls = 0;
  const cache = new RedactionPreviewCache(async () => `image-${++calls}`);
  const narrow = { ...tile, region: { ...tile.region, width: 128 } };
  const other = { ...tile, pageId: "other" };
  await expect(cache.read(overview)).resolves.toBe("image-1");
  await expect(cache.read(tile)).resolves.toBe("image-2");
  await expect(cache.read(narrow)).resolves.toBe("image-3");
  await expect(cache.read(other)).resolves.toBe("image-4");
  cache.retryPage(overview.sessionId, overview.pageId);
  await expect(cache.read(other)).resolves.toBe("image-4");
  await expect(cache.read(tile)).resolves.toBe("image-5");
  await expect(cache.read(narrow)).resolves.toBe("image-6");
  await expect(cache.read(overview)).resolves.toBe("image-7");
  cache.dispose();
});
