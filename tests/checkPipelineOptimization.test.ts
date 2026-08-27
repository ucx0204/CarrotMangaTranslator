import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type CachePlan = {
  cacheRoot: string;
  entryDirectory: string;
  inputFingerprint: string;
  inputs: string[];
  root: string;
};

type BuildCacheModule = {
  assertRealOwnedPath(
    root: string,
    candidate: string,
    options?: {
      exists(path: string): boolean;
      lstat(path: string): { isSymbolicLink(): boolean };
    },
  ): void;
  buildEnvironmentFingerprint(env: Record<string, string | undefined>): string;
  createCheckBuildPlan(root: string): CachePlan;
  isRealBuildInputFile(
    path: string,
    options?: {
      lstat(path: string): {
        isFile(): boolean;
        isSymbolicLink(): boolean;
      };
    },
  ): boolean;
  promoteCheckBuild(plan: CachePlan): { promoted: boolean };
  restoreCheckBuild(plan: CachePlan): { restored: boolean; reason: string };
};

type CheckModule = {
  buildCacheOptedIn(env: Record<string, string | undefined>): boolean;
  createStages(): Array<{ id: string; command: string; args: string[] }>;
};

type CompileElectronModule = {
  assertRealGeneratedPath(
    root: string,
    candidate: string,
    options?: {
      exists(path: string): boolean;
      lstat(path: string): { isSymbolicLink(): boolean };
    },
  ): void;
  electronTypeScriptArguments(options: { noCheck: boolean }): string[];
  parseArguments(args: string[]): { noCheck: boolean };
};

const buildCache =
  require("../scripts/check-build-cache.cjs") as BuildCacheModule;
const check = require("../scripts/check.cjs") as CheckModule;
const compileElectron =
  require("../scripts/compile-electron.cjs") as CompileElectronModule;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("check direct invocation", () => {
  it("keeps the complete stage gate without npm wrapper subprocesses", () => {
    const stages = check.createStages();
    expect(stages.map((stage) => stage.id)).toEqual([
      "private-workspace",
      "typecheck",
      "typecheck-electron",
      "typecheck-js",
      "format",
      "lint",
      "error-handling",
      "test-mock-boundaries",
      "architecture",
      "reexports",
      "generated",
      "css-structure",
      "script-entrypoints",
      "deadcode",
      "deadcode-exports",
      "prepare-electron",
      "test-coverage",
      "production-cleanup-coverage",
      "build",
      "page-artwork-parity",
      "image-protocol-smoke",
      "renderer-bundle",
      "preload-bundle",
    ]);
    expect(stages.every((stage) => stage.command === process.execPath)).toBe(
      true,
    );
    expect(
      stages.some((stage) =>
        [stage.command, ...stage.args].some((argument) =>
          /(?:^|[\\/])npm(?:-cli\.js|\.cmd)?$/iu.test(argument),
        ),
      ),
    ).toBe(false);
    expect(
      stages.find((stage) => stage.id === "prepare-electron")?.args,
    ).toEqual([expect.stringMatching(/[\\/]electron[\\/]install\.js$/u)]);
    expect(
      stages.find((stage) => stage.id === "typecheck-electron")?.args,
    ).toEqual([
      expect.stringMatching(/[\\/]typescript[\\/]bin[\\/]tsc$/u),
      "-p",
      "tsconfig.electron-typecheck.json",
    ]);
    expect(stages.find((stage) => stage.id === "test-coverage")?.args).toEqual([
      expect.stringMatching(/[\\/]vitest[\\/]vitest\.mjs$/u),
      "run",
      "--coverage",
    ]);
    expect(
      stages.find((stage) => stage.id === "production-cleanup-coverage")?.args,
    ).toEqual([
      expect.stringMatching(
        /[\\/]scripts[\\/]check-production-cleanup-coverage\.cjs$/u,
      ),
    ]);
  });

  it("keeps the unbenchmarked build cache opt-in only", () => {
    expect(check.buildCacheOptedIn({})).toBe(false);
    expect(check.buildCacheOptedIn({ MGT_CHECK_BUILD_CACHE: "0" })).toBe(false);
    expect(check.buildCacheOptedIn({ MGT_CHECK_BUILD_CACHE: "1" })).toBe(true);
  });
});

describe("check-only Electron noCheck emit", () => {
  it("adds noCheck only for the already-typechecked check build", () => {
    expect(compileElectron.parseArguments([])).toEqual({ noCheck: false });
    expect(compileElectron.parseArguments(["--noCheck"])).toEqual({
      noCheck: true,
    });
    expect(
      compileElectron.electronTypeScriptArguments({ noCheck: false }),
    ).toEqual(["-p", "tsconfig.electron.json"]);
    expect(
      compileElectron.electronTypeScriptArguments({ noCheck: true }),
    ).toEqual(["-p", "tsconfig.electron.json", "--noCheck"]);
    expect(() => compileElectron.parseArguments(["--skip-check"])).toThrow(
      /Unsupported compile-electron arguments/,
    );
  });

  it("refuses an ancestor symlink before generated output cleanup", () => {
    const root = join(tmpdir(), "manga-generated-owned-root");
    const linkedOut = join(root, "out");
    expect(() =>
      compileElectron.assertRealGeneratedPath(root, join(linkedOut, "main"), {
        exists: () => true,
        lstat: (path) => ({ isSymbolicLink: () => path === linkedOut }),
      }),
    ).toThrow(/cannot contain symbolic links/);
  });
});

describe("content-addressed check build cache", () => {
  it("promotes only when called, restores exact outputs, and invalidates input drift", () => {
    const root = createFixture();
    const plan = buildCache.createCheckBuildPlan(root);
    expect(buildCache.restoreCheckBuild(plan).restored).toBe(false);
    expect(() =>
      readFileSync(join(plan.entryDirectory, "manifest.json")),
    ).toThrow();

    expect(buildCache.promoteCheckBuild(plan).promoted).toBe(true);
    writeFileSync(join(root, "out", "main", "bootstrap.js"), "corrupt\n");
    expect(buildCache.restoreCheckBuild(plan).restored).toBe(true);
    expect(
      readFileSync(join(root, "out", "main", "bootstrap.js"), "utf8"),
    ).toBe("bootstrap\n");

    writeFileSync(join(root, "src", "main", "input.ts"), "changed\n");
    const changedPlan = buildCache.createCheckBuildPlan(root);
    expect(changedPlan.inputFingerprint).not.toBe(plan.inputFingerprint);
    expect(buildCache.restoreCheckBuild(changedPlan).restored).toBe(false);
  });

  it("treats a corrupted snapshot as a miss and refuses input-racy promotion", () => {
    const root = createFixture();
    const plan = buildCache.createCheckBuildPlan(root);
    buildCache.promoteCheckBuild(plan);
    writeFileSync(
      join(plan.entryDirectory, "snapshot", "out", "main", "bootstrap.js"),
      "corrupt\n",
    );
    expect(buildCache.restoreCheckBuild(plan)).toMatchObject({
      restored: false,
      reason: expect.stringMatching(/corrupt/),
    });

    writeFileSync(join(root, "src", "main", "input.ts"), "changed\n");
    expect(() => buildCache.promoteCheckBuild(plan)).toThrow(
      /inputs changed during check/,
    );
  });

  it("binds environment values without exposing them and ignores unrelated variables", () => {
    const first = buildCache.buildEnvironmentFingerprint({
      VITE_FEATURE: "secret-value",
      PATH: "first",
    });
    const unrelated = buildCache.buildEnvironmentFingerprint({
      VITE_FEATURE: "secret-value",
      PATH: "changed",
    });
    const changed = buildCache.buildEnvironmentFingerprint({
      VITE_FEATURE: "changed-value",
      PATH: "first",
    });
    expect(first).toBe(unrelated);
    expect(first).not.toBe(changed);
    expect(first).not.toContain("secret-value");
  });

  it("invalidates when a tracked non-source input changes", () => {
    const root = createFixture();
    write(root, "docs/build-note.md", "first\n");
    runGit(root, ["add", "docs/build-note.md"]);
    const first = buildCache.createCheckBuildPlan(root);
    write(root, "docs/build-note.md", "second\n");
    const second = buildCache.createCheckBuildPlan(root);
    expect(second.inputFingerprint).not.toBe(first.inputFingerprint);
  });

  it("fails closed for a dangling tracked input symlink", () => {
    expect(() =>
      buildCache.isRealBuildInputFile("src/dangling.ts", {
        lstat: () => ({
          isFile: () => false,
          isSymbolicLink: () => true,
        }),
      }),
    ).toThrow(/inputs cannot be symbolic links/);
  });

  it("keeps only the newest successful large build snapshot", () => {
    const root = createFixture();
    const first = buildCache.createCheckBuildPlan(root);
    buildCache.promoteCheckBuild(first);
    write(root, "src/main/input.ts", "changed\n");
    const second = buildCache.createCheckBuildPlan(root);

    buildCache.promoteCheckBuild(second);

    expect(existsSync(second.entryDirectory)).toBe(true);
    expect(existsSync(first.entryDirectory)).toBe(false);
  });

  it("refuses an ancestor symlink before recursive output cleanup", () => {
    const root = join(tmpdir(), "manga-cache-owned-root");
    const linkedOut = join(root, "out");
    expect(() =>
      buildCache.assertRealOwnedPath(root, join(linkedOut, "main"), {
        exists: () => true,
        lstat: (path) => ({
          isSymbolicLink: () => path === linkedOut,
        }),
      }),
    ).toThrow(/refuses symbolic links/);
  });

  it("restores a manifest whose directory and sibling names sort differently on Windows", () => {
    const root = createFixture();
    write(root, "out/main/library/libraryContextFacade.js", "facade");
    write(root, "out/main/libraryStore/chapterRecords.js", "records");
    const plan = buildCache.createCheckBuildPlan(root);
    buildCache.promoteCheckBuild(plan);

    expect(buildCache.restoreCheckBuild(plan)).toMatchObject({
      restored: true,
    });
  });
});

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "manga-check-cache-test-"));
  temporaryDirectories.push(root);
  for (const path of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.typecheck.json",
    "tsconfig.electron.json",
    "vite.renderer.config.ts",
    "vite.preload.config.ts",
    "vite.page-export.config.ts",
    "scripts/build.cjs",
    "scripts/compile-electron.cjs",
    "scripts/prepare-runtime.cjs",
    "scripts/codex-app-server-runtime.cjs",
    "scripts/check-build-cache.cjs",
    "node_modules/typescript/package.json",
    "node_modules/vite/package.json",
    "node_modules/@vitejs/plugin-react/package.json",
    "node_modules/electron/package.json",
    "node_modules/rolldown/package.json",
    "node_modules/@openai/codex/package.json",
    `node_modules/@openai/codex-${process.platform}-${process.arch}/package.json`,
    "node_modules/react/package.json",
    "node_modules/react-dom/package.json",
    "src/main/input.ts",
  ]) {
    write(root, path, `${path}\n`);
  }
  runGit(root, ["init", "--quiet"]);
  runGit(root, ["add", "."]);
  for (const [path, contents] of Object.entries({
    "out/main/bootstrap.js": "bootstrap\n",
    "out/main/runtime/python-pip-environment.cjs": "pip isolation\n",
    "out/shared/value.js": "shared\n",
    "out/preload/index.js": "preload\n",
    "out/page-export/runtime.js": "runtime\n",
    "out/page-export/styles.css": "styles\n",
    "out/renderer/index.html": "renderer\n",
  })) {
    write(root, path, contents);
  }
  return root;
}

function runGit(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root });
}

function write(root: string, relativePath: string, contents: string): void {
  const target = join(root, relativePath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents, "utf8");
}
