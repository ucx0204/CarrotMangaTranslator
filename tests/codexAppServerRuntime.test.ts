import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLED_CODEX_VERSION,
  resolveCodexAppServerBinary,
} from "../src/main/codexAppServerBinary";
import { CODEX_APP_SERVER_ARGUMENTS } from "../src/main/codexAppServerPolicy";

type CodexRuntimePlan = {
  sourceDir: string;
  executablePath: string;
  manifestPath: string;
  resourceDirectory: string;
};

type CodexRuntimeHelpers = {
  CODEX_APP_SERVER_ARGUMENTS: string[];
  CODEX_APP_SERVER_VERSION: string;
  assertCodexRuntimeReady: (runtime: CodexRuntimePlan) => CodexRuntimePlan;
  resolveCodexRuntime: (
    root: string,
    platform: string,
    arch: string,
  ) => CodexRuntimePlan;
};

const runtimeHelpers =
  require("../scripts/codex-app-server-runtime.cjs") as CodexRuntimeHelpers;
const repoRoot = join(__dirname, "..");
const temporaryDirectories: string[] = [];
const describeWindows = process.platform === "win32" ? describe : describe.skip;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describeWindows("official Codex App Server runtime", () => {
  it("resolves the exact pinned native npm distribution", () => {
    const runtime = runtimeHelpers.resolveCodexRuntime(
      repoRoot,
      "win32",
      "x64",
    );

    expect(runtimeHelpers.CODEX_APP_SERVER_VERSION).toBe(BUNDLED_CODEX_VERSION);
    expect(runtimeHelpers.CODEX_APP_SERVER_ARGUMENTS).toEqual(
      CODEX_APP_SERVER_ARGUMENTS,
    );
    expect(runtimeHelpers.assertCodexRuntimeReady(runtime)).toBe(runtime);
    expect(runtime.resourceDirectory).toBe("c");
    expect(runtime.executablePath).toMatch(/bin[\\/]codex\.exe$/u);

    const resolved = resolveCodexAppServerBinary(
      { isPackaged: false, resourcesDir: "unused" },
      "win32",
      "x64",
    );
    expect(resolved).toMatchObject({
      executablePath: runtime.executablePath,
      packageVersion: BUNDLED_CODEX_VERSION,
      source: "node_modules",
    });
  });

  it("starts the installed binary as an App Server and reads account state", () => {
    const runtime = runtimeHelpers.assertCodexRuntimeReady(
      runtimeHelpers.resolveCodexRuntime(repoRoot, "win32", "x64"),
    );
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "smoke-codex-app-server-runtime.cjs"),
        runtime.executablePath,
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("packaged-codex-app-server-ok");
  });

  it("resolves and version-checks the short packaged resource path", () => {
    const resourcesDir = createPackagedFixture(BUNDLED_CODEX_VERSION);
    expect(
      resolveCodexAppServerBinary(
        { isPackaged: true, resourcesDir },
        "win32",
        "x64",
      ),
    ).toMatchObject({
      executablePath: join(resourcesDir, "c", "bin", "codex.exe"),
      packageVersion: BUNDLED_CODEX_VERSION,
      source: "packaged",
    });
  });

  it("rejects a packaged runtime whose manifest version drifted", () => {
    const resourcesDir = createPackagedFixture("0.0.0");
    expect(() =>
      resolveCodexAppServerBinary(
        { isPackaged: true, resourcesDir },
        "win32",
        "x64",
      ),
    ).toThrow("내장 Codex 버전이 일치하지 않습니다");
  });
});

function createPackagedFixture(version: string): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "mgt-codex-packaged-"));
  temporaryDirectories.push(fixtureRoot);
  const resourcesDir = join(fixtureRoot, "resources");
  const runtimeDir = join(resourcesDir, "c");
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });
  writeFileSync(join(runtimeDir, "bin", "codex.exe"), "fixture");
  writeFileSync(
    join(runtimeDir, "codex-package.json"),
    JSON.stringify({ version }),
  );
  return resourcesDir;
}
