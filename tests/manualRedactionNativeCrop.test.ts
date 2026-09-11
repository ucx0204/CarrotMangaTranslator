import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { nativeImage } from "electron";
import {
  openRedactionWorkspaceSession,
  closeRedactionWorkspace,
} from "../src/main/imageRedactionWorkspaceSessions";
import { getRedactionWorkspacePreview } from "../src/main/imageRedactionWorkspacePreview";
import { redactionPreviewRequestSchema } from "../src/shared/imageRedactionWorkspace";
import { redactionPreviewVariantKey } from "../src/shared/imageRedactionPreview";

vi.mock("electron", () => ({ nativeImage: { createFromBuffer: vi.fn() } }));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "redaction-native-crop-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const imagePath = join(root, "source.png");
  await writeFile(imagePath, "original");
  const sessionId = randomUUID();
  await openRedactionWorkspaceSession(
    [
      {
        id: "a",
        name: "source.png",
        imagePath,
        width: 3000,
        height: 10000,
        fingerprint: createHash("sha256").update("original").digest("hex"),
        strokes: [],
      },
    ],
    sessionId,
    root,
  );
  cleanup.push(() => closeRedactionWorkspace(sessionId));
  const crop = vi.fn(
    (region: { x: number; y: number; width: number; height: number }) => ({
      getSize: () => ({ width: region.width, height: region.height }),
      toDataURL: () => `native:${region.x}:${region.y}`,
    }),
  );
  const resize = vi.fn(() => ({ toDataURL: () => "overview" }));
  vi.mocked(nativeImage.createFromBuffer).mockReturnValue({
    isEmpty: () => false,
    getSize: () => ({ width: 3000, height: 10000 }),
    crop,
    resize,
  } as Electron.NativeImage);
  return {
    request: { sessionId, pageId: "a", maxEdge: 2048 as const },
    imagePath,
    crop,
    resize,
  };
}
it("serves immutable native crops without resizing or confusing overview and crop cache entries", async () => {
  const f = await fixture();
  const decode = vi.fn(async () => null);
  const a = {
    ...f.request,
    region: { x: 10, y: 3000, width: 900, height: 700 },
  };
  const b = { ...a, region: { ...a.region, x: 20 } };
  expect(await getRedactionWorkspacePreview(f.request, decode)).toBe(
    "overview",
  );
  expect(await getRedactionWorkspacePreview(a, decode)).toBe("native:10:3000");
  expect(await getRedactionWorkspacePreview(b, decode)).toBe("native:20:3000");
  expect(await getRedactionWorkspacePreview(a, decode)).toBe("native:10:3000");
  expect(f.crop).toHaveBeenCalledTimes(2);
  expect(f.crop).toHaveBeenCalledWith(a.region);
  expect(f.resize).toHaveBeenCalledOnce();
  expect(decode).not.toHaveBeenCalled();
  await writeFile(f.imagePath, "replacement");
  await expect(getRedactionWorkspacePreview(a, decode)).rejects.toThrow("변경");
});
it("rejects invalid crop size and source bounds before invoking a decoder", async () => {
  const f = await fixture();
  const decode = vi.fn(async () => null);
  const region = { x: 2999, y: 0, width: 2, height: 2 };
  await expect(
    getRedactionWorkspacePreview({ ...f.request, region }, decode),
  ).rejects.toThrow("outside");
  for (const invalid of [{ x: -1 }, { width: 2049 }, { height: 0 }, { x: 0.5 }])
    expect(
      redactionPreviewRequestSchema.safeParse({
        ...f.request,
        region: { ...region, ...invalid },
      }).success,
    ).toBe(false);
  expect(f.crop).not.toHaveBeenCalled();
  expect(decode).not.toHaveBeenCalled();
  expect(redactionPreviewVariantKey(2048)).not.toBe(
    redactionPreviewVariantKey(2048, region),
  );
});
