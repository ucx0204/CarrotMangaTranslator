import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeInferencePlan } from "../src/main/runtimeSupport/nativeInferencePlan";
import { ensureNativeInferenceRuntime } from "../src/main/runtimeSupport/nativeInferenceRuntime";

const state = vi.hoisted(() => ({
  download: vi.fn(),
  format: "zip",
  only: undefined as string[] | undefined,
}));
vi.mock("../src/main/runtimeSupport/modelDownloads", () => ({
  ensureRemoteFile: state.download,
}));
vi.mock("../src/main/runtime/native-inference-manifest.json", () => ({
  default: {
    version: "test-native-v1",
    packages: new Proxy(
      {},
      {
        get: () => ({
          format: state.format,
          preservePaths: true,
          url: "https://example.invalid/runtime.zip",
          sha256: "a".repeat(64),
          bytes: 123,
        }),
      },
    ),
  },
}));
const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const tar = require("tar");
let root: string;
let archive: string;
const plan = (backend: "cpu" | "rocm" = "cpu") =>
  nativeInferencePlan({
    engine: "torch",
    backend,
    platform: process.platform,
    arch: process.arch,
    rocmTarget: "gfx1100",
  });
const library = process.platform === "win32" ? "c10.dll" : "libc10.dylib";
const options = () => ({
  runtimeDir: root,
  engine: "torch" as const,
  backend: "cpu" as const,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mgt-native-runtime-test-"));
  archive = join(root, "fixture.zip");
  const zip = new AdmZip();
  const allLibraries = new Set([
    ...plan().libraries,
    ...(process.platform === "win32" ? plan("rocm").libraries : []),
  ]);
  for (const name of allLibraries)
    zip.addFile(name, Buffer.from("verified native library"));
  zip.addFile("readme.txt", Buffer.from("not a library"));
  zip.writeZip(archive);
  state.format = "zip";
  state.only = undefined;
  state.download.mockReset().mockResolvedValue(archive);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("native runtime installation", () => {
  it.runIf(process.platform === "win32")(
    "verifies and repairs the packaged Vulkan executable as well as its libraries",
    async () => {
      const vulkan = {
        runtimeDir: root,
        engine: "diffusion" as const,
        backend: "vulkan" as const,
      };
      const spec = nativeInferencePlan({
        ...vulkan,
        platform: "win32",
        arch: "x64",
      });
      if (!spec.executable) throw new Error("Missing Vulkan executable");
      const zip = new AdmZip();
      for (const name of [...spec.libraries, spec.executable])
        zip.addFile(name, Buffer.from("verified Vulkan bytes"));
      zip.writeZip(archive);
      const installed = await ensureNativeInferenceRuntime(vulkan);
      if (!installed.executable)
        throw new Error("Missing installed executable");
      expect(installed.executable).toBe(
        join(installed.directory, spec.executable),
      );
      await writeFile(installed.executable, "tampered");
      await ensureNativeInferenceRuntime(vulkan);
      expect(await readFile(installed.executable, "utf8")).toBe(
        "verified Vulkan bytes",
      );
      const receiptPath = join(installed.directory, ".native-runtime.json");
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      receipt.files = receipt.files.filter(
        (file: { path: string }) => file.path !== spec.executable,
      );
      await writeFile(receiptPath, JSON.stringify(receipt));
      await writeFile(installed.executable, "unverified");
      await ensureNativeInferenceRuntime(vulkan);
      expect(await readFile(installed.executable, "utf8")).toBe(
        "verified Vulkan bytes",
      );
    },
  );
  it("installs a real archive, binds absolute library paths, and reuses verified bytes", async () => {
    const installed = await ensureNativeInferenceRuntime(options());
    const spec = JSON.parse(await readFile(installed.manifest, "utf8"));
    expect(spec).toEqual({
      schema: 1,
      engine: "torch",
      backend: "cpu",
      libraries: plan().libraries.map((name) =>
        join(installed.directory, name),
      ),
    });
    expect(await readdir(installed.directory)).not.toContain("readme.txt");
    await ensureNativeInferenceRuntime(options());
    expect(state.download).toHaveBeenCalledTimes(plan().packages.length);
    expect(state.download).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSha256: "a".repeat(64),
        minimumBytes: 123,
        maximumBytes: 123,
      }),
    );
  });

  it("repairs modified libraries and a receipt that omits a required library", async () => {
    const installed = await ensureNativeInferenceRuntime(options());
    await writeFile(join(installed.directory, library), "corrupt");
    await ensureNativeInferenceRuntime(options());
    expect(await readFile(join(installed.directory, library), "utf8")).toBe(
      "verified native library",
    );
    const receiptPath = join(installed.directory, ".native-runtime.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.files.find((file: { path: string }) => file.path === library).path =
      "unrelated.dll";
    await writeFile(
      join(installed.directory, "unrelated.dll"),
      "verified native library",
    );
    await writeFile(receiptPath, JSON.stringify(receipt));
    await ensureNativeInferenceRuntime(options());
    expect(state.download).toHaveBeenCalledTimes(3 * plan().packages.length);
  });

  it("extracts a tar package through the same validated gateway", async () => {
    const source = join(root, "tar-source");
    await mkdir(source);
    for (const name of plan().libraries) {
      await mkdir(dirname(join(source, name)), { recursive: true });
      await writeFile(join(source, name), "tar library");
    }
    archive = join(root, "fixture.tar.gz");
    await tar.c({ gzip: true, cwd: source, file: archive }, plan().libraries);
    state.format = "tar";
    state.only = [library];
    state.download.mockResolvedValue(archive);
    const installed = await ensureNativeInferenceRuntime(options());
    expect(await readFile(join(installed.directory, library), "utf8")).toBe(
      "tar library",
    );
  });

  it("never publishes incomplete downloads and permits a subsequent retry", async () => {
    state.download.mockRejectedValueOnce(new Error("network interrupted"));
    await expect(ensureNativeInferenceRuntime(options())).rejects.toThrow(
      "network interrupted",
    );
    expect(await readdir(root)).toEqual(["fixture.zip"]);
    await expect(
      ensureNativeInferenceRuntime(options()),
    ).resolves.toHaveProperty("manifest");
  });

  it("rejects a package missing its required native library", async () => {
    const zip = new AdmZip();
    zip.addFile("other.dll", Buffer.from("wrong package"));
    zip.writeZip(archive);
    await expect(ensureNativeInferenceRuntime(options())).rejects.toThrow();
    expect(await readdir(root)).toEqual(["fixture.zip"]);
  });

  it("shares concurrent installs while independently cancelling a waiter", async () => {
    let release!: (path: string) => void;
    state.download.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const owner = ensureNativeInferenceRuntime(options());
    await vi.waitFor(() => expect(state.download).toHaveBeenCalledTimes(1));
    const abort = new AbortController();
    const waiter = ensureNativeInferenceRuntime({
      ...options(),
      signal: abort.signal,
    });
    const rejected = expect(waiter).rejects.toThrow("cancel waiter");
    abort.abort(new Error("cancel waiter"));
    await rejected;
    release(archive);
    await owner;
    await ensureNativeInferenceRuntime(options());
    expect(state.download).toHaveBeenCalledTimes(plan().packages.length);
  });

  it("a waiting caller retries after the owner fails", async () => {
    let fail!: (error: Error) => void;
    state.download.mockImplementationOnce(
      () =>
        new Promise<string>((_, reject) => {
          fail = reject;
        }),
    );
    const owner = ensureNativeInferenceRuntime(options());
    const rejected = expect(owner).rejects.toThrow("owner failed");
    await vi.waitFor(() => expect(state.download).toHaveBeenCalledTimes(1));
    const waiter = ensureNativeInferenceRuntime(options());
    fail(new Error("owner failed"));
    await rejected;
    await expect(waiter).resolves.toHaveProperty("manifest");
    expect(state.download).toHaveBeenCalledTimes(1 + plan().packages.length);
  });

  it("honors cancellation before touching the filesystem", async () => {
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(
      ensureNativeInferenceRuntime({ ...options(), signal: abort.signal }),
    ).rejects.toThrow("cancelled");
    expect(state.download).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")(
    "installs ROCm under a long Windows data path without changing the data root",
    async () => {
      const longRoot = join(root, "한글-runtime-" + "x".repeat(130), "models");
      const installed = await ensureNativeInferenceRuntime({
        ...options(),
        runtimeDir: longRoot,
        backend: "rocm",
        rocmTarget: "gfx1100",
      });
      expect(installed.directory).toContain(longRoot);
      expect(await readFile(join(installed.directory, library), "utf8")).toBe(
        "verified native library",
      );
    },
  );
});
