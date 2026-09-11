import { expect, it } from "vitest";
import { RedactionPreviewCache } from "../src/renderer/src/components/imageRedaction/redactionPreviewCache";
import type { RedactionPreviewRequest } from "../src/shared/imageRedactionWorkspace";
const request = (id: string): RedactionPreviewRequest => ({
  sessionId: "11111111-1111-4111-8111-111111111111",
  pageId: id,
  maxEdge: 320,
});
it("limits concurrent loading, deduplicates and prioritizes the current page", async () => {
  const started: string[] = [];
  const releases = new Map<string, (value: string) => void>();
  const cache = new RedactionPreviewCache(async (input) => {
    started.push(input.pageId);
    return new Promise<string>((resolve) =>
      releases.set(input.pageId, resolve),
    );
  });
  const loading = ["0", "1", "2", "3", "4"].map((id) =>
    cache.read(request(id)),
  );
  expect(started).toEqual(["0", "1", "2"]);
  expect(cache.read(request("4"), true)).toBe(loading[4]);
  releases.get("0")?.("url-0");
  await loading[0];
  expect(started).toEqual(["0", "1", "2", "4"]);
  releases.get("1")?.("url-1");
  await loading[1];
  expect(started.at(-1)).toBe("3");
  for (const id of ["2", "3", "4"]) releases.get(id)?.(`url-${id}`);
  await Promise.all(loading);
  await expect(cache.read(request("0"))).resolves.toBe("url-0");
  expect(started).toHaveLength(5);
  cache.dispose();
});
it("does not cache failed reads and rejects queued requests on disposal", async () => {
  let fail = true;
  const cache = new RedactionPreviewCache(async () => {
    if (fail) throw new Error("decode failed");
    return "valid";
  });
  await expect(cache.read(request("0"))).rejects.toThrow("decode failed");
  fail = false;
  await expect(cache.read(request("0"))).resolves.toBe("valid");
  cache.dispose();
  await expect(cache.read(request("1"))).rejects.toThrow("closed");
});
