import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import * as runtimeModules from "../src/main/runtimeModuleLoader";
import { QwenGpuBudget } from "../src/main/inpainting/qwenGpuBudget";

const { execute, lookup } = vi.hoisted(() => ({
  execute: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: Object.assign(lookup, {
    [Symbol.for("nodejs.util.promisify.custom")]: execute,
  }),
}));

const uuid = "GPU-550e8400-e29b-41d4-a716-446655440000";

describe("Qwen GPU ownership", () => {
  beforeEach(() => {
    execute.mockReset();
    lookup.mockReset().mockImplementation((_file, _args, options, callback) => {
      expect(options.env.CUDA_VISIBLE_DEVICES).toBe(uuid);
      callback(null, "000000010000f606");
    });
  });

  it("yields to personal Flux on the selected adapter, then resumes when its allocation is released", async () => {
    let allocated = true;
    execute.mockImplementation(async (file: string, args: string[]) => {
      if (file === "nvidia-smi") {
        expect(args[0]).toBe(`--id=${uuid}`);
        const stdout = args[1].startsWith("--query-compute")
          ? "13, C:\\Python\\python.exe, [N/A]\n99, sd-cli.exe, 1430"
          : "12288, 4700";
        return { stdout };
      }
      const query = args.at(-1) ?? "";
      if (query.includes("Win32_Process")) return { stdout: "True" };
      expect(query).toContain("pid_(?:13)_luid_0x00000001_0x0000f606");
      return { stdout: allocated ? "True" : "False" };
    });
    const budget = new QwenGpuBudget(uuid);
    expect(await budget.status(99)).toBe("inference");
    allocated = false;
    expect(await budget.status(99)).toBe("ready");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("stops its own child on board pressure even while a competing-process probe is outstanding", async () => {
    let probes = 0;
    execute.mockImplementation(
      async (_: string, args: string[], options: { signal: AbortSignal }) => {
        if (args[1].startsWith("--query-gpu")) {
          probes++;
          return { stdout: probes === 1 ? "12288, 7000" : "12288, 10500" };
        }
        return new Promise((_, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      },
    );
    const stop = vi.fn();
    const status = await new QwenGpuBudget(uuid).monitor(
      99,
      new Promise(() => {}),
      stop,
    );
    expect(status).toBe("memory");
    expect(probes).toBe(2);
    expect(stop).toHaveBeenCalledOnce();
  });
  it("allows a free board and releases both observers when the crop finishes", async () => {
    execute.mockImplementation(async (_file: string, args: string[]) => ({
      stdout: args[1].startsWith("--query-gpu") ? "12288, 3200" : "",
    }));
    const budget = new QwenGpuBudget(uuid);
    const change = vi.fn();
    await budget.wait(new AbortController().signal, change);
    expect(change).not.toHaveBeenCalled();
    const stop = vi.fn();
    expect(await budget.monitor(99, Promise.resolve(), stop)).toBe("ready");
    expect(stop).not.toHaveBeenCalled();
    execute.mockRejectedValueOnce(new Error("GPU telemetry unavailable"));
    await expect(
      budget.monitor(99, new Promise(() => {}), stop),
    ).rejects.toThrow("GPU telemetry unavailable");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("samples the selected board without spawning memory probes and releases its NVML handle", async () => {
    const binding = join("runtime", "koffi.node");
    const events: string[] = [];
    const loader = vi.spyOn(runtimeModules, "loadRuntimeModuleFromDirectory");
    try {
      const invoke = (name: string, args: unknown[]) => {
        events.push(name);
        if (name.includes("ByUUID")) {
          expect(args[0]).toBe(uuid);
          (args[1] as number[])[0] = 123;
        } else if (name.includes("MemoryInfo")) {
          const bytes = args[1] as Buffer;
          expect(args[0]).toBe(123);
          expect(bytes.readUInt32LE()).toBe(0x02000028);
          bytes.writeBigUInt64LE(12288n << 20n, 8);
          bytes.writeBigUInt64LE(10600n << 20n, 32);
        }
        return 0;
      };
      loader.mockReturnValue({
        load: () => ({
          func:
            (name: string) =>
            (...args: unknown[]) =>
              invoke(name, args),
        }),
      });
      execute.mockImplementation(async (_file: string, args: string[]) => {
        expect(args[1]).toContain("compute-apps");
        return { stdout: "" };
      });
      const stop = vi.fn();
      expect(
        await new QwenGpuBudget(uuid, binding).monitor(
          12,
          new Promise(() => {}),
          stop,
        ),
      ).toBe("memory");
      expect(stop).toHaveBeenCalledOnce();
      expect(loader).toHaveBeenCalledWith("runtime", "nativeFfi");
      expect(events.map((name) => name.split("(")[0])).toEqual([
        "int nvmlInit_v2",
        "int nvmlDeviceGetHandleByUUID",
        "int nvmlDeviceGetMemoryInfo_v2",
        "int nvmlShutdown",
      ]);
    } finally {
      loader.mockRestore();
    }
  });
});
