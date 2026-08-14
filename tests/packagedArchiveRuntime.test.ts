import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

type RuntimeRequire = (specifier: string) => unknown;
type PackagedRequireFactory = (filename: string) => RuntimeRequire;
type RuntimeLoader = (options?: {
  moduleRequire?: RuntimeRequire;
  resourcesPath?: string;
  createPackagedRequire?: PackagedRequireFactory;
}) => unknown;

const { loadTarRuntime } =
  require("../src/main/runtime/simple-page-tar-utils.cjs") as {
    loadTarRuntime: RuntimeLoader;
  };
const { loadYauzlRuntime } =
  require("../src/main/runtime/simple-page-zip-utils.cjs") as {
    loadYauzlRuntime: RuntimeLoader;
  };

describe.each([
  {
    format: "tar",
    loadRuntime: loadTarRuntime,
    createRuntime: () => ({ x: vi.fn(), t: vi.fn() }),
  },
  {
    format: "ZIP",
    loadRuntime: loadYauzlRuntime,
    createRuntime: () => ({ open: vi.fn() }),
  },
])(
  "packaged $format runtime resolution",
  ({ format, loadRuntime, createRuntime }) => {
    const specifier = format === "tar" ? "tar" : "yauzl";

    it("uses the ordinary dependency lookup in development", () => {
      const directRuntime = createRuntime();
      const moduleRequire = vi.fn(() => directRuntime);
      const createPackagedRequire = vi.fn();

      expect(loadRuntime({ moduleRequire, createPackagedRequire })).toBe(
        directRuntime,
      );
      expect(moduleRequire).toHaveBeenCalledWith(specifier);
      expect(createPackagedRequire).not.toHaveBeenCalled();
    });

    it("retries from app.asar when app-runtime is outside the archive", () => {
      const missing = Object.assign(
        new Error(`Cannot find module '${specifier}'`),
        { code: "MODULE_NOT_FOUND" },
      );
      const moduleRequire = vi.fn(() => {
        throw missing;
      });
      const packagedRuntime = createRuntime();
      const packagedRequire = vi.fn(() => packagedRuntime);
      const createPackagedRequire = vi.fn(() => packagedRequire);
      const resourcesPath = join("Applications", "Example.app", "Resources");

      expect(
        loadRuntime({ moduleRequire, resourcesPath, createPackagedRequire }),
      ).toBe(packagedRuntime);
      expect(createPackagedRequire).toHaveBeenCalledWith(
        join(resourcesPath, "app.asar", "package.json"),
      );
      expect(packagedRequire).toHaveBeenCalledWith(specifier);
    });

    it("does not hide unrelated module initialization errors", () => {
      const failure = new Error(`${specifier} initialization failed`);
      const moduleRequire = vi.fn(() => {
        throw failure;
      });

      expect(() =>
        loadRuntime({ moduleRequire, resourcesPath: "/Applications/App" }),
      ).toThrow(failure);
    });
  },
);
