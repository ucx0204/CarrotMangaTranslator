import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findPythonCommand } from "../src/main/inpainting/fluxAssets/pythonBootstrap";

const boundary = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: boundary.spawn,
}));
vi.mock("electron", () => ({ app: { isPackaged: false } }));

const platform = Object.getOwnPropertyDescriptor(process, "platform");
if (!platform) throw new Error("Missing process platform descriptor");
const roots: string[] = [];
const order: string[] = [];
const fetchBoundary = vi.fn<typeof fetch>();

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32" });
  for (const prefix of ["MANGA_TRANSLATOR_FLUX_", "MGT_FLUX_"])
    for (const suffix of [
      "PYTHON",
      "PYTHON_VERSION",
      "PYTHON_URL",
      "PYTHON_SHA256",
      "GET_PIP_URL",
      "GET_PIP_SHA256",
      "ALLOW_SYSTEM_PYTHON",
    ])
      vi.stubEnv(prefix + suffix, undefined);
  vi.stubEnv("MGT_FLUX_ALLOW_SYSTEM_PYTHON", "0");
  order.length = 0;
  boundary.spawn.mockReset().mockImplementation((command: string) => {
    order.push(`probe:${command}`);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      kill: vi.fn(),
    });
    queueMicrotask(() =>
      child.emit("exit", command === "missing-python" ? 1 : 0),
    );
    return child;
  });
  fetchBoundary.mockReset().mockImplementation(async (_url, init) => {
    order.push(`download:${init?.method ?? "GET"}`);
    return new Response(null, {
      status: 404,
      statusText: "Bootstrap unavailable",
    });
  });
  vi.stubGlobal("fetch", fetchBoundary);
});

afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});

describe("Windows Flux Python discovery", () => {
  it("selects a configured interpreter without provisioning the managed runtime", async () => {
    const runtimeDir = await emptyRuntime();
    vi.stubEnv("MGT_FLUX_PYTHON", "configured-python");
    await expect(findPythonCommand({ runtimeDir })).resolves.toEqual({
      command: "configured-python",
      args: [],
    });
    expect(boundary.spawn).toHaveBeenCalledExactlyOnceWith(
      "configured-python",
      ["--version"],
      expect.any(Object),
    );
    expect(fetchBoundary).not.toHaveBeenCalled();
    expect(await readdir(runtimeDir)).toEqual([]);
  });

  it("tries an allowed system interpreter after the override and managed download fail", async () => {
    const runtimeDir = await emptyRuntime();
    vi.stubEnv("MGT_FLUX_PYTHON", "missing-python");
    vi.stubEnv("MGT_FLUX_ALLOW_SYSTEM_PYTHON", "true");
    await expect(findPythonCommand({ runtimeDir })).resolves.toEqual({
      command: "py",
      args: ["-3"],
    });
    expect(order[0]).toBe("probe:missing-python");
    expect(order).toContain("download:GET");
    expect(order.at(-1)).toBe("probe:py");
    expect(
      boundary.spawn.mock.calls.map(([command, args]) => [command, args]),
    ).toEqual([
      ["missing-python", ["--version"]],
      ["py", ["-3", "--version"]],
    ]);
  });

  it("preserves the managed provisioning failure when system fallback is disabled", async () => {
    const runtimeDir = await emptyRuntime();
    vi.stubEnv("MGT_FLUX_PYTHON", "missing-python");
    await expect(findPythonCommand({ runtimeDir })).rejects.toThrow(/404/);
    expect(order).toContain("download:GET");
    expect(boundary.spawn).toHaveBeenCalledOnce();
  });
});

async function emptyRuntime() {
  const directory = await mkdtemp(join(tmpdir(), "flux-python-discovery-"));
  roots.push(directory);
  return directory;
}
