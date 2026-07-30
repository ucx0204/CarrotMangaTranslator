import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORCE_HIGH_PERFORMANCE_GPU_SWITCH,
  parseBootstrapGraphicsGpuPreference,
  readBootstrapGraphicsGpuPreference,
  resolveBootstrapGraphicsGpuPreference,
  resolveBootstrapGraphicsGpuPreferenceFromEnv,
  resolveBootstrapSettingsPath,
  resolveGraphicsGpuSwitch,
} from "../src/main/bootstrapGraphicsGpu";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("bootstrap graphics GPU preference", () => {
  it("reads only the persisted hardware graphics preference", () => {
    expect(
      resolveBootstrapGraphicsGpuPreference({
        hardware: { graphicsGpuPreference: "high-performance" },
      }),
    ).toBe("high-performance");
    expect(
      resolveBootstrapGraphicsGpuPreference({
        graphicsGpuPreference: "high-performance",
      }),
    ).toBe("auto");
  });

  it("falls back to auto for malformed or unsupported settings", () => {
    expect(parseBootstrapGraphicsGpuPreference("{ malformed")).toBe("auto");
    expect(parseBootstrapGraphicsGpuPreference("[]")).toBe("auto");
    expect(
      parseBootstrapGraphicsGpuPreference(
        JSON.stringify({
          hardware: { graphicsGpuPreference: "low-power" },
        }),
      ),
    ).toBe("auto");
  });

  it("reads settings.json below the supplied data root", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "mgt-bootstrap-gpu-"));
    tempDirs.push(dataRoot);
    const settingsPath = resolveBootstrapSettingsPath(dataRoot);
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hardware: { graphicsGpuPreference: "high-performance" },
      }),
      "utf8",
    );

    expect(settingsPath).toBe(join(dataRoot, "settings.json"));
    expect(readBootstrapGraphicsGpuPreference(settingsPath)).toBe(
      "high-performance",
    );
  });

  it("falls back to auto when settings.json cannot be read", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "mgt-bootstrap-gpu-"));
    tempDirs.push(dataRoot);

    expect(
      readBootstrapGraphicsGpuPreference(
        resolveBootstrapSettingsPath(dataRoot),
      ),
    ).toBe("auto");
  });

  it("uses the graphics environment default before settings are saved", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "mgt-bootstrap-gpu-"));
    tempDirs.push(dataRoot);
    const settingsPath = resolveBootstrapSettingsPath(dataRoot);
    const env = {
      MANGA_TRANSLATOR_GRAPHICS_GPU_PREFERENCE: "high-performance",
    };

    expect(resolveBootstrapGraphicsGpuPreferenceFromEnv(env)).toBe(
      "high-performance",
    );
    expect(readBootstrapGraphicsGpuPreference(settingsPath, env)).toBe(
      "high-performance",
    );

    writeFileSync(
      settingsPath,
      JSON.stringify({
        hardware: { graphicsGpuPreference: "auto" },
      }),
      "utf8",
    );
    expect(readBootstrapGraphicsGpuPreference(settingsPath, env)).toBe("auto");
  });

  it("forces the high-performance GPU only outside macOS", () => {
    expect(resolveGraphicsGpuSwitch("high-performance", "win32")).toBe(
      FORCE_HIGH_PERFORMANCE_GPU_SWITCH,
    );
    expect(resolveGraphicsGpuSwitch("high-performance", "linux")).toBe(
      FORCE_HIGH_PERFORMANCE_GPU_SWITCH,
    );
    expect(resolveGraphicsGpuSwitch("high-performance", "darwin")).toBeNull();
    expect(resolveGraphicsGpuSwitch("auto", "win32")).toBeNull();
  });
});
