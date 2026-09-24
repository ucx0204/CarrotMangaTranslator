import { expect, it, vi } from "vitest";
import {
  acquireInpaintingEngine,
  disposeCachedInpaintingEngines,
  type InpaintingEnginePoolDependencies,
} from "../src/main/inpainting/inpaintingEnginePool";
import { makeContext, createDeferred } from "./inpaintingSelectionJobFixtures";
import {
  releaseModelResource,
  assertModelCleanupComplete,
} from "../src/main/runtimeSupport/modelCleanupBarrier";
vi.mock("electron", () => ({ app: { isPackaged: false }, nativeImage: {} }));

function fixture() {
  const engine = {
    model: "flux-klein" as const,
    runtimePath: "test",
    runRootDir: "test",
    backend: "test",
    inpaint: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  const release = vi.fn(async () => {});
  const acquire = vi.fn(async () => ({ engine, release }));
  const dependencies: InpaintingEnginePoolDependencies = {
    acquireFlux: acquire,
    acquireKoharu: acquire,
    disposeFlux: vi.fn(async () => false),
    disposeKoharu: vi.fn(async () => false),
    totalMemoryBytes: () => 32 * 1024 ** 3,
  };
  return {
    engine,
    release,
    acquire,
    dependencies,
    appPaths: makeContext(vi.fn()).appPaths,
  };
}
it.each(["flux-klein", "lama-manga"] as const)(
  "reuses %s inside a workload and awaits disposal exactly once on release",
  async (model) => {
    const f = fixture();
    const entered = createDeferred<void>(),
      finish = createDeferred<void>();
    const dispose = vi.fn(async () => {
      entered.resolve();
      await finish.promise;
      return true;
    });
    if (model === "flux-klein") f.dependencies.disposeFlux = dispose;
    else f.dependencies.disposeKoharu = dispose;
    const lease = await acquireInpaintingEngine(
      { appPaths: f.appPaths, model },
      f.dependencies,
    );
    expect(lease.engine).toBe(f.engine);
    expect(dispose).not.toHaveBeenCalled();
    let released = false;
    const pending = Promise.resolve(lease.release()).then(() => {
      released = true;
    });
    await entered.promise;
    expect(f.release).toHaveBeenCalledOnce();
    expect(released).toBe(false);
    const duplicate = lease.release();
    expect(dispose).toHaveBeenCalledOnce();
    finish.resolve();
    await Promise.all([pending, duplicate]);
    expect(released).toBe(true);
    expect(dispose).toHaveBeenCalledWith("workload-complete");
  },
);
it("does not create the next model if the previous model cannot be released", async () => {
  const f = fixture();
  f.dependencies.disposeKoharu = vi.fn(async () => {
    throw new Error("old model remains");
  });
  await expect(
    acquireInpaintingEngine(
      { appPaths: f.appPaths, model: "flux-klein" },
      f.dependencies,
    ),
  ).rejects.toThrow("old model remains");
  expect(f.acquire).not.toHaveBeenCalled();
});
it("a failed workload release rejects and keeps model admission blocked until confirmed recovery", async () => {
  const f = fixture();
  f.dependencies.disposeFlux = async () => {
    await releaseModelResource(f.engine, async () => {
      throw new Error("still alive");
    });
    return true;
  };
  const lease = await acquireInpaintingEngine(
    { appPaths: f.appPaths, model: "flux-klein" },
    f.dependencies,
  );
  try {
    await expect(lease.release()).rejects.toThrow("모델");
    expect(() => assertModelCleanupComplete()).toThrow();
    await expect(
      acquireInpaintingEngine(
        { appPaths: f.appPaths, model: "lama-manga" },
        f.dependencies,
      ),
    ).rejects.toThrow();
    expect(f.acquire).toHaveBeenCalledOnce();
  } finally {
    await releaseModelResource(f.engine, async () => {});
  }
});
it("waits for all cleanup attempts even when another pool fails immediately", async () => {
  const f = fixture();
  const finish = createDeferred<void>();
  f.dependencies.disposeFlux = async () => {
    throw new Error("failed");
  };
  f.dependencies.disposeKoharu = async () => {
    await finish.promise;
    return true;
  };
  let done = false;
  const pending = disposeCachedInpaintingEngines("shutdown", f.dependencies);
  const checked = expect(pending)
    .rejects.toThrow("cleanup")
    .then(() => {
      done = true;
    });
  await Promise.resolve();
  await Promise.resolve();
  expect(done).toBe(false);
  finish.resolve();
  await checked;
});
