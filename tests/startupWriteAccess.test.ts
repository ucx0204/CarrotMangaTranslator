import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeStartupWriteAccess } from "../src/main/startupWriteAccess";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(join(tmpdir(), "mgt-startup-write-test-"));
  temporaryRoots.push(root);
  return root;
}

function ioError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

function probeFiles(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true })
    .map(String)
    .filter((name) => name.includes(".mgt-write-probe-"));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("startup write-access probe", () => {
  it("creates required storage and cleans its probes without changing data", () => {
    const root = temporaryRoot();
    const settings = join(root, "settings.json");
    fs.writeFileSync(settings, '{"keep":true}\n');
    fs.mkdirSync(join(root, "library"));
    fs.writeFileSync(join(root, "library", "original.png"), "untouched image");

    expect(probeStartupWriteAccess(root)).toEqual({ status: "writable" });
    expect(probeStartupWriteAccess(root)).toEqual({ status: "writable" });
    expect(fs.readFileSync(settings, "utf8")).toBe('{"keep":true}\n');
    expect(fs.readFileSync(join(root, "library", "original.png"), "utf8")).toBe(
      "untouched image",
    );
    expect(fs.statSync(join(root, "tmp", "system-temp")).isDirectory()).toBe(
      true,
    );
    expect(probeFiles(root)).toEqual([]);
  });

  it("rejects relative paths before touching the filesystem", () => {
    const mkdir = vi.spyOn(fs, "mkdirSync");
    expect(probeStartupWriteAccess("relative-data")).toMatchObject({
      status: "unavailable",
      path: "relative-data",
    });
    expect(mkdir).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EPERM"])(
    "distinguishes %s from non-permission failures",
    (code) => {
      const root = temporaryRoot();
      const error = ioError(code);
      vi.spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
        throw error;
      });
      expect(probeStartupWriteAccess(root)).toEqual({
        status: "permission-denied",
        path: root,
        error,
      });
    },
  );

  it("reports disk exhaustion without requesting elevation and cleans up", () => {
    const root = temporaryRoot();
    const error = ioError("ENOSPC");
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw error;
    });
    expect(probeStartupWriteAccess(root)).toEqual({
      status: "unavailable",
      path: root,
      error,
    });
    expect(probeFiles(root)).toEqual([]);
  });

  it("checks replacement, not just creation, and cleans up a failed rename", () => {
    const root = temporaryRoot();
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw ioError("EACCES");
    });
    expect(probeStartupWriteAccess(root).status).toBe("permission-denied");
    expect(probeFiles(root)).toEqual([]);
  });

  it("keeps deletion denial permission-related when the scratch directory stays nonempty", () => {
    const root = temporaryRoot();
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (String(path).endsWith("destination")) {
        throw ioError("EACCES");
      }
      unlink(path);
    });
    const result = probeStartupWriteAccess(root);
    expect(result.status).toBe("permission-denied");
    if (result.status !== "writable") {
      expect(result.error).toBeInstanceOf(AggregateError);
    }
  });

  it("preserves a non-permission primary failure together with cleanup failure", () => {
    const root = temporaryRoot();
    const primary = ioError("ENOSPC");
    const cleanup = ioError("EACCES");
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw primary;
    });
    vi.spyOn(fs, "rmdirSync").mockImplementationOnce(() => {
      throw cleanup;
    });
    const result = probeStartupWriteAccess(root);
    expect(result.status).toBe("unavailable");
    if (result.status !== "writable") {
      expect(result.error).toBeInstanceOf(AggregateError);
      expect((result.error as AggregateError).errors).toEqual([
        primary,
        cleanup,
      ]);
    }
  });

  it("checks existing child folders even when the data root is writable", () => {
    const root = temporaryRoot();
    const library = join(root, "library");
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation((path, options) => {
      if (String(path) === library) {
        throw ioError("EACCES");
      }
      return mkdir(path, options);
    });
    expect(probeStartupWriteAccess(root)).toMatchObject({
      status: "permission-denied",
      path: library,
    });
  });

  it("does not overwrite a file that occupies a required directory", () => {
    const root = temporaryRoot();
    const blocked = join(root, "electron-user-data");
    fs.writeFileSync(blocked, "keep this file");
    expect(probeStartupWriteAccess(root)).toMatchObject({
      status: "unavailable",
      path: blocked,
    });
    expect(fs.readFileSync(blocked, "utf8")).toBe("keep this file");
  });
});
