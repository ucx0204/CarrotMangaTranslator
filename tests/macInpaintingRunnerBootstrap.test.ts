import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { resolveMacInpaintingRunnerPaths, resolveMissingMacInpaintingRunners } =
  require("../scripts/mac-inpainting-runners.cjs") as {
    resolveMacInpaintingRunnerPaths: (root: string) => string[];
    resolveMissingMacInpaintingRunners: (
      root: string,
      options: {
        platform: NodeJS.Platform;
        arch: string;
        isUsable: (filePath: string) => boolean;
      },
    ) => string[];
  };

describe("macOS inpainting runner bootstrap", () => {
  it("requires both native runners on Apple Silicon", () => {
    const root = join("workspace", "CarrotMangaTranslator");
    const paths = resolveMacInpaintingRunnerPaths(root);

    expect(paths).toEqual([
      join(
        root,
        "tools",
        "mgt-koharu-inpaint-runner",
        "target",
        "aarch64-apple-darwin",
        "release",
        "mgt-koharu-inpaint-runner",
      ),
      join(
        root,
        "tools",
        "mgt-flux-klein-runner",
        "target",
        "aarch64-apple-darwin",
        "release",
        "mgt-flux-klein",
      ),
    ]);
    expect(
      resolveMissingMacInpaintingRunners(root, {
        platform: "darwin",
        arch: "arm64",
        isUsable: vi.fn(() => false),
      }),
    ).toEqual(paths);
  });

  it("does not build Metal runners on other platforms", () => {
    const isUsable = vi.fn(() => false);
    expect(
      resolveMissingMacInpaintingRunners("workspace", {
        platform: "win32",
        arch: "x64",
        isUsable,
      }),
    ).toEqual([]);
    expect(isUsable).not.toHaveBeenCalled();
  });
});
