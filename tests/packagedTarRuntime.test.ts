import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { loadTarRuntime } =
  require("../src/main/runtime/simple-page-tar-utils.cjs") as {
    loadTarRuntime: (options?: {
      moduleRequire?: NodeRequire;
      resourcesPath?: string;
      createPackagedRequire?: typeof createRequire;
    }) => unknown;
  };

describe("packaged tar runtime resolution", () => {
  it("uses the ordinary dependency lookup in development", () => {
    const directRuntime = { x: vi.fn(), t: vi.fn() };
    const moduleRequire = vi.fn(() => directRuntime) as unknown as NodeRequire;
    const createPackagedRequire = vi.fn();

    expect(loadTarRuntime({ moduleRequire, createPackagedRequire })).toBe(
      directRuntime,
    );
    expect(moduleRequire).toHaveBeenCalledWith("tar");
    expect(createPackagedRequire).not.toHaveBeenCalled();
  });

  it("retries from app.asar when app-runtime is outside the archive", () => {
    const missing = Object.assign(new Error("Cannot find module 'tar'"), {
      code: "MODULE_NOT_FOUND",
    });
    const moduleRequire = vi.fn(() => {
      throw missing;
    }) as unknown as NodeRequire;
    const packagedRuntime = { x: vi.fn(), t: vi.fn() };
    const packagedRequire = vi.fn(
      () => packagedRuntime,
    ) as unknown as NodeRequire;
    const createPackagedRequire = vi.fn(
      () => packagedRequire,
    ) as unknown as typeof createRequire;
    const resourcesPath = join("Applications", "Example.app", "Resources");

    expect(
      loadTarRuntime({
        moduleRequire,
        resourcesPath,
        createPackagedRequire,
      }),
    ).toBe(packagedRuntime);
    expect(createPackagedRequire).toHaveBeenCalledWith(
      join(resourcesPath, "app.asar", "package.json"),
    );
    expect(packagedRequire).toHaveBeenCalledWith("tar");
  });

  it("does not hide unrelated module initialization errors", () => {
    const failure = new Error("tar initialization failed");
    const moduleRequire = vi.fn(() => {
      throw failure;
    }) as unknown as NodeRequire;

    expect(() =>
      loadTarRuntime({ moduleRequire, resourcesPath: "/Applications/App" }),
    ).toThrow(failure);
  });
});
