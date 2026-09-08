import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fsPromises from "node:fs/promises";
import { queryWindowsDirectMlAdapter } from "../src/main/runtimeSupport/windowsDirectMlAdapter";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

type ProbeOptions = { env: NodeJS.ProcessEnv; windowsHide: boolean };
type ProbeCallback = (error: Error | null, stdout: string) => void;
const adapter = {
  deviceId: 0,
  name: "Test adapter",
  luid: "0000000000000001",
  highPerformanceRank: 0,
  dedicatedVideoMemory: 512,
};
const result = JSON.stringify({ adapters: [adapter], cudaLuid: adapter.luid });
let fixture: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "mgt-dml-probe-test-"));
  vi.stubEnv("TEMP", join(fixture, "missing", "temp"));
  vi.stubEnv("TMP", join(fixture, "missing", "temp"));
  vi.stubEnv("LOCALAPPDATA", join(fixture, "local-app-data"));
  execFileMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(fixture, { recursive: true, force: true });
});

function assertWritableProbeTemp(options: ProbeOptions): string {
  const directory = options.env.TEMP;
  expect(directory).toBeTruthy();
  if (!directory) throw new Error("Probe temp directory is missing");
  expect(options.env.TMP).toBe(directory);
  expect(statSync(directory).isDirectory()).toBe(true);
  writeFileSync(
    join(directory, "compiler-output.dll"),
    "temporary compiler output",
  );
  expect(options.windowsHide).toBe(true);
  return directory;
}

describe("Windows DirectML probe temporary files", () => {
  it("reports unavailable temporary storage without starting a compiler", async () => {
    vi.stubEnv("LOCALAPPDATA", undefined);
    const failure = Object.assign(
      new Error("Temporary storage is unavailable"),
      {
        code: "EACCES",
      },
    );
    vi.mocked(fsPromises.mkdir)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure);
    await expect(queryWindowsDirectMlAdapter({})).rejects.toMatchObject({
      name: "AggregateError",
      errors: [failure, failure],
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("uses a writable private temp directory and cleans it after a successful probe", async () => {
    const hostTemp = process.env.TEMP;
    let probeTemp = "";
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        options: ProbeOptions,
        callback: ProbeCallback,
      ) => {
        probeTemp = assertWritableProbeTemp(options);
        expect(probeTemp).not.toBe(hostTemp);
        callback(null, result);
      },
    );
    await expect(queryWindowsDirectMlAdapter({})).resolves.toEqual(adapter);
    expect(existsSync(probeTemp)).toBe(false);
    expect(process.env.TEMP).toBe(hostTemp);
  });

  it("recovers when the inherited temp path is a file", async () => {
    const unusable = join(fixture, "not-a-directory");
    writeFileSync(unusable, "must remain untouched");
    vi.stubEnv("TEMP", unusable);
    vi.stubEnv("TMP", unusable);
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        options: ProbeOptions,
        callback: ProbeCallback,
      ) => {
        assertWritableProbeTemp(options);
        callback(null, result);
      },
    );
    await expect(queryWindowsDirectMlAdapter({})).resolves.toEqual(adapter);
    expect(statSync(unusable).isFile()).toBe(true);
  });

  it("cleans the compiler directory on failure while preserving the original error", async () => {
    const failure = new Error("DXGI unavailable");
    let probeTemp = "";
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        options: ProbeOptions,
        callback: ProbeCallback,
      ) => {
        probeTemp = assertWritableProbeTemp(options);
        callback(failure, "");
      },
    );
    await expect(queryWindowsDirectMlAdapter({})).rejects.toBe(failure);
    expect(existsSync(probeTemp)).toBe(false);
  });

  it("preserves CUDA enumeration isolation and does not share concurrent compiler directories", async () => {
    vi.stubEnv("CUDA_DEVICE_ORDER", "PCI_BUS_ID");
    const directories: string[] = [];
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        options: ProbeOptions,
        callback: ProbeCallback,
      ) => {
        directories.push(assertWritableProbeTemp(options));
        expect(options.env.CUDA_VISIBLE_DEVICES).toBe("2");
        expect(options.env.CUDA_DEVICE_ORDER).toBeUndefined();
        queueMicrotask(() => callback(null, result));
      },
    );
    await Promise.all([
      queryWindowsDirectMlAdapter({
        computeGpuBackend: "cuda",
        computeGpuIndex: 2,
      }),
      queryWindowsDirectMlAdapter({
        computeGpuBackend: "cuda",
        computeGpuIndex: 2,
      }),
    ]);
    expect(new Set(directories).size).toBe(2);
    expect(directories.every((directory) => !existsSync(directory))).toBe(true);
    expect(process.env.CUDA_DEVICE_ORDER).toBe("PCI_BUS_ID");
  });
});
