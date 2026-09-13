import { afterEach, expect, it, vi } from "vitest";
import {
  nativeRedactionPreviewKey,
  nativeRedactionPreviewTiles,
  renderNativeRedactionPreview,
} from "../src/renderer/src/components/imageRedaction/redactionNativeSurface";
import type { RedactionPreviewSource } from "../src/renderer/src/components/imageRedaction/redactionWorkspaceTypes";

afterEach(() => vi.unstubAllGlobals());

function boundary(wrongSize = false) {
  const drawImage = vi.fn();
  vi.stubGlobal("document", {
    createElement: () => ({ getContext: () => ({ drawImage }) }),
  });
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 0;
      naturalHeight = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        const [width, height] = value.split(":").map(Number);
        this.naturalWidth = wrongSize ? width - 1 : width;
        this.naturalHeight = height;
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  let version = 0;
  const read = vi.fn<RedactionPreviewSource["read"]>(
    async ({ region }) => `${region?.width}:${region?.height}`,
  );
  const source: RedactionPreviewSource = {
    read,
    version: () => version,
    retryPage: () => {
      version++;
    },
    subscribe: () => () => {},
  };
  return { source, read, drawImage };
}

it("uses bounded native crops at original offsets, and changes identity after retry", async () => {
  const { source, read, drawImage } = boundary();
  const page = { id: "page", width: 3000, height: 10000 };
  const window = { x: 700, y: 7000, width: 2300, height: 600, factor: 1 };
  expect(nativeRedactionPreviewKey(source, "session", page, window, 99)).toBe(
    "",
  );
  const key = nativeRedactionPreviewKey(source, "session", page, window, 100);
  source.retryPage("session", "page");
  expect(
    nativeRedactionPreviewKey(source, "session", page, window, 100),
  ).not.toBe(key);
  expect(nativeRedactionPreviewTiles(window)).toHaveLength(2);
  const result = await renderNativeRedactionPreview(
    source,
    "session",
    "page",
    window,
    new AbortController().signal,
  );
  expect([result.width, result.height]).toEqual([2300, 600]);
  expect(read.mock.calls.map(([input]) => input.region)).toEqual([
    { x: 700, y: 7000, width: 2048, height: 600 },
    { x: 2748, y: 7000, width: 252, height: 600 },
  ]);
  expect(drawImage.mock.calls.map((call) => call.slice(1))).toEqual([
    [0, 0],
    [2048, 0],
  ]);
});

it("rejects resized crops rather than marking a low-resolution overview ready", async () => {
  const { source, drawImage } = boundary(true);
  await expect(
    renderNativeRedactionPreview(
      source,
      "session",
      "page",
      { x: 0, y: 0, width: 100, height: 100 },
      new AbortController().signal,
    ),
  ).rejects.toThrow("unexpected size");
  expect(drawImage).not.toHaveBeenCalled();
});

it("does not decode or publish a request cancelled while its crop was loading", async () => {
  const { source, read, drawImage } = boundary();
  const controller = new AbortController();
  read.mockImplementationOnce(async () => {
    controller.abort(new Error("viewport changed"));
    return "100:100";
  });
  await expect(
    renderNativeRedactionPreview(
      source,
      "session",
      "page",
      { x: 0, y: 0, width: 100, height: 100 },
      controller.signal,
    ),
  ).rejects.toThrow("viewport changed");
  expect(drawImage).not.toHaveBeenCalled();
});
