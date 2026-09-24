import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAppRelaunch } from "../src/main/appRelaunch";

const electron = vi.hoisted(() => ({ isPackaged: false, relaunch: vi.fn() }));
vi.mock("electron", () => ({ app: electron }));
const originalSend = process.send;
afterEach(() => {
  process.send = originalSend;
  electron.isPackaged = false;
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("application relaunch", () => {
  it("waits for the development supervisor request to be delivered before allowing quit", async () => {
    vi.stubEnv("MGT_DEV_SUPERVISED_RELAUNCH", "1");
    let delivered: (error: Error | null) => void = () => undefined;
    const send = vi.fn((_message: unknown, callback?: unknown) => {
      if (typeof callback !== "function") throw new Error("Expected callback");
      delivered = callback as typeof delivered;
      return true;
    });
    process.send = send;
    let ready = false;
    const pending = prepareAppRelaunch().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(send).toHaveBeenCalledWith(
      { type: "mgt:dev-relaunch" },
      expect.any(Function),
    );
    expect(electron.relaunch).not.toHaveBeenCalled();
    delivered(null);
    await pending;
    expect(ready).toBe(true);
  });

  it("reports a lost supervisor channel instead of launching an untracked child", async () => {
    vi.stubEnv("MGT_DEV_SUPERVISED_RELAUNCH", "1");
    process.send = (_message: unknown, callback?: unknown) => {
      if (typeof callback !== "function") throw new Error("Expected callback");
      callback(new Error("IPC disconnected"));
      return false;
    };
    await expect(prepareAppRelaunch()).rejects.toThrow("IPC disconnected");
    expect(electron.relaunch).not.toHaveBeenCalled();
  });

  it.each(["packaged", "unsupervised", "no-ipc"])(
    "retains native relaunch for %s launches",
    async (mode) => {
      vi.stubEnv(
        "MGT_DEV_SUPERVISED_RELAUNCH",
        mode === "unsupervised" ? "" : "1",
      );
      electron.isPackaged = mode === "packaged";
      const send = vi.fn();
      process.send = mode === "no-ipc" ? undefined : send;
      await prepareAppRelaunch();
      expect(electron.relaunch).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
    },
  );
});
