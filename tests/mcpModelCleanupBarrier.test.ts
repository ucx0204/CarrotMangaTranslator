import { expect, it, vi } from "vitest";
import { AppActivityGate } from "../src/main/appActivityGate";
import {
  assertModelCleanupComplete,
  ModelCleanupError,
  releaseModelResource,
} from "../src/main/runtimeSupport/modelCleanupBarrier";

it("blocks model admission during release and after failure, but permits unrelated text edits", async () => {
  const gate = new AppActivityGate();
  const resource = {};
  let reject!: (error: Error) => void;
  const dispose = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const pending = releaseModelResource(resource, dispose);
  const observed = expect(pending).rejects.toBeInstanceOf(ModelCleanupError);
  try {
    expect(releaseModelResource(resource, dispose)).toBe(pending);
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    expect(() => gate.assertAvailable([{ kind: "model-runtime", scope: "*", access: "write" }])).toThrow(ModelCleanupError);
    const edit = gate.acquire({ id: "text-edit", kind: "mcp-edit", category: "job", mutatesLibrary: true, blocksQuit: true, resources: [{ kind: "page-content", scope: "chapter/other", access: "write" }] });
    expect(() => edit.updateResources([{ kind: "model-runtime", scope: "*", access: "write" }])).toThrow(ModelCleanupError);
    edit.release();
    reject(new Error("native termination not acknowledged"));
    await observed;
    expect(() => assertModelCleanupComplete()).toThrow(ModelCleanupError);
    expect(() => gate.acquire({ id: "legacy", kind: "inpainting", category: "job", mutatesLibrary: true, blocksQuit: true })).toThrow(ModelCleanupError);
    await releaseModelResource(resource, async () => {});
    expect(() => gate.assertAvailable([{ kind: "model-runtime", scope: "*", access: "write" }])).not.toThrow();
  } finally {
    reject?.(new Error("test cleanup"));
    await Promise.allSettled([pending]);
    await releaseModelResource(resource, async () => {});
  }
});

it("one successful release cannot clear another failed model's fence", async () => {
  const a = {}, b = {};
  try {
    await expect(releaseModelResource(a, async () => { throw new Error("A"); })).rejects.toThrow(ModelCleanupError);
    await expect(releaseModelResource(b, async () => { throw new Error("B"); })).rejects.toThrow(ModelCleanupError);
    await releaseModelResource(a, async () => {});
    expect(() => assertModelCleanupComplete()).toThrow(ModelCleanupError);
    await releaseModelResource(b, async () => {});
    expect(() => assertModelCleanupComplete()).not.toThrow();
  } finally {
    await releaseModelResource(a, async () => {});
    await releaseModelResource(b, async () => {});
  }
});
