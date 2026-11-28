import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareNativeInferenceLaunch } from "../src/main/runtimeSupport/nativeInferenceLaunch";
import windowsRuntimePaths from "./fixtures/windows-native-runtime-paths.json";

const mock = vi.hoisted(() => ({ install: vi.fn(), exec: vi.fn() }));
vi.mock("../src/main/runtimeSupport/nativeInferenceRuntime", () => ({
  ensureNativeInferenceRuntime: mock.install,
}));
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mock.exec(...args),
}));
let root: string;
let executable: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mgt-native-launch-test-"));
  executable = join(root, "worker.exe");
  await writeFile(executable, "runner");
  mock.install.mockReset().mockImplementation(async ({ engine }) => ({
    directory: root,
    manifest: join(root, engine + ".json"),
    pathDirectories: [root],
  }));
  mock.exec
    .mockReset()
    .mockImplementation((_command, _args, _options, callback) =>
      callback(null, {
        stdout: JSON.stringify({ schema: 1, gpu_index: 1, target: "gfx1100" }),
      }),
    );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const options = () => ({
  runtimeDir: root,
  executable,
  engine: "torch" as const,
  backend: "cuda" as const,
});

describe("native inference launch", () => {
  it("launches the verified Vulkan package executable without a ROCm probe", async () => {
    mock.install.mockResolvedValue({
      directory: root,
      executable,
      manifest: join(root, "diffusion.json"),
      pathDirectories: [root],
    });
    const result = await prepareNativeInferenceLaunch({
      runtimeDir: root,
      engine: "diffusion",
      backend: "vulkan",
    });
    expect(result.executable).toBe(executable);
    expect(mock.exec).not.toHaveBeenCalled();
    expect(result.env.HIP_PATH).toBeUndefined();
    mock.install.mockResolvedValue({
      directory: root,
      manifest: "missing",
      pathDirectories: [],
    });
    await expect(
      prepareNativeInferenceLaunch({
        runtimeDir: root,
        engine: "diffusion",
        backend: "vulkan",
      }),
    ).rejects.toThrow("no executable");
    await expect(
      prepareNativeInferenceLaunch({
        runtimeDir: root,
        engine: "diffusion",
        backend: "rocm",
      }),
    ).rejects.toThrow("probe requires");
  });
  it.each(windowsRuntimePaths)(
    "keeps native SDK environment paths joinable: $input",
    async ({ input, expected }) => {
      vi.stubGlobal("process", { ...process, platform: "win32" });
      const manifest = win32.join(input, "runtime.json");
      mock.install.mockResolvedValue({
        directory: input,
        manifest,
        pathDirectories: [input, win32.join(input, "_rocm_sdk_core", "bin")],
      });
      const result = await prepareNativeInferenceLaunch({
        ...options(),
        backend: "rocm",
        computeGpuIndex: 1,
      });
      const paths = [expected, win32.join(expected, "_rocm_sdk_core", "bin")];
      // Stubbing process.platform does not change node:path's host semantics.
      // Compare the complete PATH so POSIX ':' does not split a drive letter.
      const expectedPath = [...paths, process.env.PATH]
        .filter(Boolean)
        .join(delimiter);
      expect(result.env.PATH).toBe(expectedPath);
      expect(mock.exec.mock.calls[0]?.[2].env.PATH).toBe(expectedPath);
      expect(result.env.HIP_PATH).toBe(join(expected, "_rocm_sdk_core"));
      expect(result.env.ROCM_PATH).toBe(join(expected, "_rocm_sdk_core"));
      expect(result.manifest).toBe(manifest);
    },
  );
  it("uses the selected engine runtime without probing an unrelated GPU", async () => {
    const result = await prepareNativeInferenceLaunch(options());
    expect(mock.exec).not.toHaveBeenCalled();
    expect(result.executable).toBe(executable);
    expect(result.manifest).toBe(join(root, "torch.json"));
    expect(result.env.PATH).toContain(root);
  });
  it("probes the selected AMD index before installing its exact device package", async () => {
    vi.stubEnv("HIP_VISIBLE_DEVICES", "4");
    const result = await prepareNativeInferenceLaunch({
      ...options(),
      backend: "rocm",
      computeGpuIndex: 1,
    });
    expect(
      mock.install.mock.calls.map(([x]) => [x.engine, x.rocmTarget]),
    ).toEqual([
      ["rocm-probe", undefined],
      ["torch", "gfx1100"],
    ]);
    expect(mock.exec.mock.calls[0]?.[1]).toEqual([
      "--probe-rocm",
      join(root, "rocm-probe.json"),
      "1",
    ]);
    expect(mock.exec.mock.calls[0]?.[2]).toMatchObject({
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 256 * 1024,
    });
    expect(result.env.HIP_PATH).toBe(join(root, "_rocm_sdk_core"));
    expect(
      mock.exec.mock.calls[0]?.[2].env.HIP_VISIBLE_DEVICES,
    ).toBeUndefined();
  });
  it.each([
    "not-json",
    JSON.stringify({ schema: 2, gpu_index: 1, target: "gfx1100" }),
    JSON.stringify({ schema: 1, gpu_index: 0, target: "gfx1100" }),
    JSON.stringify({ schema: 1, gpu_index: 1, target: "gfx110X" }),
  ])("rejects an untrusted probe result: %s", async (stdout) => {
    mock.exec.mockImplementation((_command, _args, _options, callback) =>
      callback(null, { stdout }),
    );
    await expect(
      prepareNativeInferenceLaunch({
        ...options(),
        backend: "rocm",
        computeGpuIndex: 1,
      }),
    ).rejects.toThrow();
    expect(mock.install).toHaveBeenCalledTimes(1);
  });
  it("does not fall back to CPU after a driver/probe error", async () => {
    mock.exec.mockImplementation((_command, _args, _options, callback) =>
      callback(new Error("HIP unavailable")),
    );
    await expect(
      prepareNativeInferenceLaunch({ ...options(), backend: "rocm" }),
    ).rejects.toThrow("HIP unavailable");
    expect(mock.install).toHaveBeenCalledTimes(1);
  });
  it("uses the Koharu HIP probe to select the kernel for the separate Qwen executable", async () => {
    vi.stubEnv("MGT_KOHARU_RUNNER_EXE", executable);
    const inference = join(root, "sd-cli");
    await writeFile(inference, "qwen runner");
    mock.install.mockImplementation(async ({ engine }) => ({
      directory: root,
      manifest: join(root, engine + ".json"),
      executable: engine === "qwen-image" ? inference : undefined,
      pathDirectories: [root],
    }));
    const result = await prepareNativeInferenceLaunch({
      runtimeDir: root,
      engine: "qwen-image",
      backend: "rocm",
      computeGpuIndex: 1,
    });
    const [probe, args] = mock.exec.mock.calls[0];
    expect(await readFile(probe, "utf8")).toBe("runner");
    expect(probe).not.toBe(inference);
    expect(args).toEqual(["--probe-rocm", join(root, "rocm-probe.json"), "1"]);
    expect(mock.install.mock.calls.map(([request]) => request)).toMatchObject([
      { engine: "rocm-probe", qwenRocmProbe: true },
      { engine: "qwen-image", rocmTarget: "gfx1100" },
    ]);
    expect(result.executable).toBe(inference);
    expect(await readFile(result.executable, "utf8")).toBe("qwen runner");
  });
  it("starts an installed Metal executable already next to its dylibs", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    mock.install.mockResolvedValue({
      directory: root,
      executable,
      manifest: join(root, "qwen-image.json"),
      pathDirectories: [root],
    });
    const result = await prepareNativeInferenceLaunch({
      runtimeDir: root,
      engine: "qwen-image",
      backend: "metal",
    });
    expect(result.executable).toBe(executable);
    expect(await readFile(executable, "utf8")).toBe("runner");
  });
  it("colocates the macOS worker with its installed dylibs", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const directory = join(root, "native-metal");
    await mkdir(directory);
    mock.install.mockResolvedValue({
      directory,
      manifest: join(directory, "torch.json"),
      pathDirectories: [directory],
    });
    const result = await prepareNativeInferenceLaunch({
      ...options(),
      backend: "metal",
    });
    expect(result.executable).toBe(join(directory, "worker.exe"));
    expect(await readFile(result.executable, "utf8")).toBe("runner");
  });
});
