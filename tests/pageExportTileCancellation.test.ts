import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPageExportTilePlan,
  stitchPageExportTilesWithFfmpeg,
  type PageExportTileStitchRequest,
} from "../src/main/pageExportTileStitch";

const boundary = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: boundary.spawn }));

class StitchProcess extends EventEmitter {
  stderr = new PassThrough();
  stdout = null;
  stdin = null;
  kill = vi.fn(() => true);
}
let child: StitchProcess;

beforeEach(() => {
  vi.useFakeTimers();
  child = new StitchProcess();
  boundary.spawn.mockReset().mockReturnValue(child);
});
afterEach(() => {
  child.emit("close", null);
  vi.useRealTimers();
});

function request(signal?: AbortSignal): PageExportTileStitchRequest {
  const expected = { width: 2, height: 2 };
  return {
    expected,
    signal,
    format: "png",
    outputPath: "output.png",
    tiles: createPageExportTilePlan(expected).map((tile) => ({
      ...tile,
      path: "tile.png",
    })),
  };
}

it("kills a cancelled stitcher and waits for process close before releasing its file owner", async () => {
  const controller = new AbortController();
  let settled = false;
  const rendering = stitchPageExportTilesWithFfmpeg(
    request(controller.signal),
    "ffmpeg",
  ).finally(() => {
    settled = true;
  });
  const rejected = expect(rendering).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort(new DOMException("cancelled", "AbortError"));
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit("close", null);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("does not spawn a stitcher for an already cancelled session", async () => {
  const signal = AbortSignal.abort(new DOMException("cancelled", "AbortError"));
  await expect(
    stitchPageExportTilesWithFfmpeg(request(signal), "ffmpeg"),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(boundary.spawn).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("removes the abort listener after successful process completion", async () => {
  const controller = new AbortController();
  const rendering = stitchPageExportTilesWithFfmpeg(
    request(controller.signal),
    "ffmpeg",
  );
  child.emit("close", 0);
  await rendering;
  controller.abort();
  expect(child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves a stitcher error and clears its cancellation listener", async () => {
  const controller = new AbortController();
  const rendering = stitchPageExportTilesWithFfmpeg(
    request(controller.signal),
    "ffmpeg",
  );
  const rejected = expect(rendering).rejects.toThrow("spawn failed");
  child.emit("error", new Error("spawn failed"));
  child.emit("error", new Error("secondary failure"));
  child.emit("close", 1);
  await rejected;
  controller.abort();
  expect(child.kill).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("times out the native stitcher and still waits for close before cleanup", async () => {
  const rendering = stitchPageExportTilesWithFfmpeg(request(), "ffmpeg");
  const rejected = expect(rendering).rejects.toThrow(
    "tile stitching timed out",
  );
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  child.emit("close", null);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it.each([1, null])(
  "preserves bounded native encoder diagnostics for exit code %s",
  async (code) => {
    const rendering = stitchPageExportTilesWithFfmpeg(request(), "ffmpeg");
    const rejected = expect(rendering).rejects.toThrow(
      `failed (${code ?? "unknown"}): ${"x".repeat(16_384)}`,
    );
    child.stderr.write("x".repeat(20_000));
    child.stderr.write("ignored excess diagnostics");
    child.emit("close", code);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  },
);
