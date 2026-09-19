import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const repoRoot = join(__dirname, "..");
const describeWindows = process.platform === "win32" ? describe : describe.skip;
describeWindows("Windows thin distribution plan", () => {
  it("keeps external Flux runners out of the thin package plan", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const {
      createWindowsThinDistributionPlan,
      shouldBuildFluxNvidiaRunners,
      shouldUseDistributionShell,
    } = require("../scripts/windows-thin-dist-plan.cjs") as {
      createWindowsThinDistributionPlan(options: {
        nodeCommand: string;
        withFluxNvidia: boolean;
        env: NodeJS.ProcessEnv;
      }): Array<{
        command: string;
        args: string[];
        env: NodeJS.ProcessEnv;
      }>;
      shouldBuildFluxNvidiaRunners(
        argv: string[],
        env: NodeJS.ProcessEnv,
      ): boolean;
      shouldUseDistributionShell(
        command: string,
        nodeCommand: string,
        platform: NodeJS.Platform,
      ): boolean;
    };

    expect(packageJson.scripts?.["dist:win"]).not.toContain(
      "--with-flux-nvidia",
    );
    expect(packageJson.scripts?.["dist:win:nvidia"]).toContain(
      "--with-flux-nvidia",
    );
    expect(
      shouldBuildFluxNvidiaRunners(["node", "dist", "--with-flux-nvidia"], {}),
    ).toBe(true);
    expect(
      shouldBuildFluxNvidiaRunners([], {
        MGT_BUILD_FLUX_NVIDIA_RUNNERS: "1",
      }),
    ).toBe(true);

    const plan = createWindowsThinDistributionPlan({
      nodeCommand: "C:\\node\\node.exe",
      withFluxNvidia: true,
      env: {},
    });
    expect(plan).toEqual([
      {
        command: "C:\\node\\node.exe",
        args: ["scripts/prepare-flux-klein-runner.cjs"],
        env: {
          MGT_FLUX_KLEIN_COMPUTE_CAPS: "75,80,86,89,90,120",
          MGT_FORCE_REBUILD_FLUX_RUNNER: "1",
        },
      },
      {
        command: "C:\\node\\node.exe",
        args: ["scripts/prepare-koharu-cuda-runner.cjs", "--check"],
        env: {},
      },
      {
        command: "C:\\node\\node.exe",
        args: ["scripts/prepare-import-source-runner.cjs"],
        env: {},
      },
      { command: "npm", args: ["run", "build"], env: {} },
      {
        command: "C:\\node\\node.exe",
        args: ["scripts/build-windows-installer.cjs"],
        env: { MGT_BUNDLE_FLUX_NVIDIA_RUNNERS: "1" },
      },
      {
        command: "C:\\node\\node.exe",
        args: ["scripts/verify-packaged-runtime.cjs"],
        env: {},
      },
    ]);
    const thinPlan = createWindowsThinDistributionPlan({
      nodeCommand: "C:\\node\\node.exe",
      withFluxNvidia: false,
      env: {},
    });
    expect(
      thinPlan.some((command) =>
        command.args.includes("scripts/prepare-flux-klein-cpu-runner.cjs"),
      ),
    ).toBe(false);
    expect(
      thinPlan.some((command) =>
        command.args.includes("scripts/prepare-flux-klein-runner.cjs"),
      ),
    ).toBe(false);
    expect(thinPlan.map((command) => command.args[0])).toContain(
      "scripts/prepare-import-source-runner.cjs",
    );
    expect(
      shouldUseDistributionShell(
        "C:\\node\\node.exe",
        "C:\\node\\node.exe",
        "win32",
      ),
    ).toBe(false);
    expect(
      shouldUseDistributionShell("npm", "C:\\node\\node.exe", "win32"),
    ).toBe(true);
  });
});
