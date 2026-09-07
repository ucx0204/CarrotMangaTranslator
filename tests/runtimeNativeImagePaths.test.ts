import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makePngImage } from "./helpers/imageFixtures";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it("uses the same readable bytes when the native path decoder returns empty", () => {
  const root = mkdtempSync(join(tmpdir(), "native-image-path-"));
  roots.push(root);
  const path = join(root, "image.png"),
    bytes = makePngImage(17, 9);
  writeFileSync(path, bytes);
  const decoded = {
    isEmpty: () => false,
    getSize: () => ({ width: 17, height: 9 }),
  };
  const native = {
    createFromPath: vi.fn(() => ({ isEmpty: () => true })),
    createFromBuffer: vi.fn(() => decoded),
  };
  const {
    loadNativeImage,
  } = require("../src/main/runtime/assets/image-source-assets.cjs");
  expect(loadNativeImage(native, path)).toBe(decoded);
  expect(native.createFromBuffer).toHaveBeenCalledWith(bytes);
});
