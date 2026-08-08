import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

type RuntimeRequire = (specifier: string) => unknown;
type PackagedRequireFactory = (filename: string) => RuntimeRequire;

const { loadYauzlRuntime } =
  require("../src/main/runtime/simple-page-zip-utils.cjs") as {
    loadYauzlRuntime: (options?: {
      moduleRequire?: RuntimeRequire;
      resourcesPath?: string;
      createPackagedRequire?: PackagedRequireFactory;
    }) => unknown;
  };

describe("packaged ZIP runtime resolution", () => {
  it("uses the ordinary dependency lookup in development", () => {
    const directRuntime = { open: vi.fn() };
    const moduleRequire = vi.fn(() => directRuntime);
    const createPackagedRequire = vi.fn();

    expect(loadYauzlRuntime({ moduleRequire, createPackagedRequire })).toBe(
      directRuntime,
    );
    expect(moduleRequire).toHaveBeenCalledWith("yauzl");
    expect(createPackagedRequire).not.toHaveBeenCalled();
  });

  it("retries from app.asar when app-runtime is outside the archive", () => {
    const missing = Object.assign(new Error("Cannot find module 'yauzl'"), {
      code: "MODULE_NOT_FOUND",
    });
    const moduleRequire = vi.fn(() => {
      throw missing;
    });
    const packagedRuntime = { open: vi.fn() };
    const packagedRequire = vi.fn(() => packagedRuntime);
    const createPackagedRequire = vi.fn(() => packagedRequire);
    const resourcesPath = join("Applications", "Example.app", "Resources");

    expect(
      loadYauzlRuntime({
        moduleRequire,
        resourcesPath,
        createPackagedRequire,
      }),
    ).toBe(packagedRuntime);
    expect(createPackagedRequire).toHaveBeenCalledWith(
      join(resourcesPath, "app.asar", "package.json"),
    );
    expect(packagedRequire).toHaveBeenCalledWith("yauzl");
  });

  it("does not hide unrelated module initialization errors", () => {
    const failure = new Error("yauzl initialization failed");
    const moduleRequire = vi.fn(() => {
      throw failure;
    });

    expect(() =>
      loadYauzlRuntime({ moduleRequire, resourcesPath: "/Applications/App" }),
    ).toThrow(failure);
  });
});
