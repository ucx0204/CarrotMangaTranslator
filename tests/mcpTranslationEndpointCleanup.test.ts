import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  loadRuntimeModules,
  ModelEndpointSession,
} from "../src/main/pipeline/runtimeModules";
import {
  modelCleanupIsBlocked,
  releaseModelResource,
} from "../src/main/runtimeSupport/modelCleanupBarrier";
import { translationFixture as fixture } from "./mcpBlockTranslation.fixture";

it("makes concurrent endpoint disposal callers await the same actual shutdown", async () => {
  const f = await fixture();
  const runtime = loadRuntimeModules(join(process.cwd(), "src/main/runtime"));
  const endpoint = {
    baseUrl: "http://127.0.0.1:1",
    child: null,
    startedByScript: true,
  };
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = vi
    .spyOn(runtime.simplePage, "stopServer")
    .mockReturnValue(waiting);
  const session = new ModelEndpointSession(runtime, endpoint, {
    ...f.options,
    modelProvider: "gemma",
  });
  const first = session.dispose();
  const second = session.dispose();
  let secondFinished = false;
  const observed = second.then(() => {
    secondFinished = true;
  });
  try {
    await Promise.resolve();
    expect(secondFinished).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(endpoint);
    expect(() => session.handle).toThrow();
    finish();
    await Promise.all([first, observed]);
    expect(secondFinished).toBe(true);
    await session.dispose();
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    finish();
    await Promise.allSettled([first, observed]);
    stop.mockRestore();
    await f.close();
  }
});

it("retries the retained endpoint after cleanup failure instead of falsely clearing the model barrier", async () => {
  const f = await fixture();
  const runtime = loadRuntimeModules(join(process.cwd(), "src/main/runtime"));
  const endpoint = {
    baseUrl: "http://127.0.0.1:1",
    child: null,
    startedByScript: true,
  };
  const stop = vi
    .spyOn(runtime.simplePage, "stopServer")
    .mockRejectedValueOnce(new Error("shutdown not confirmed"))
    .mockResolvedValue(undefined);
  const session = new ModelEndpointSession(runtime, endpoint, {
    ...f.options,
    modelProvider: "gemma",
  });
  try {
    await expect(
      releaseModelResource(session, () => session.dispose()),
    ).rejects.toMatchObject({ code: "MODEL_CLEANUP_INCOMPLETE" });
    expect(modelCleanupIsBlocked()).toBe(true);
    expect(() => session.handle).toThrow();
    await releaseModelResource(session, () => session.dispose());
    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenNthCalledWith(2, endpoint);
    expect(modelCleanupIsBlocked()).toBe(false);
    await session.dispose();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(() => session.handle).toThrow();
  } finally {
    stop.mockResolvedValue(undefined);
    await releaseModelResource(session, () => session.dispose());
    stop.mockRestore();
    await f.close();
  }
});
