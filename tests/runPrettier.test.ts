import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type RunPrettierModule = {
  assertAuthoritativePaths(paths: string[]): string[];
  buildPathBatches(paths: string[], maximumCharacters?: number): string[][];
  collectPrettierInventory(options: {
    root: string;
    listFiles?: () => string[];
    lstat?: (path: string) => {
      isFile(): boolean;
      isSymbolicLink(): boolean;
    };
  }): Promise<string[]>;
  isPersonalLocalFile(path: string): boolean;
  parseCliMode(args: string[]): "check" | "write";
  runPrettier(
    mode: "check" | "write",
    paths: string[],
    options: { root: string },
  ): number;
};

const runner = require("../scripts/run-prettier.cjs") as RunPrettierModule;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("run-prettier inventory", () => {
  it("includes tracked and non-ignored untracked files only", async () => {
    const root = createGitRepository();
    write(root, ".gitignore", "scratch/\n");
    write(root, ".prettierignore", "docs/generated.md\n");
    write(root, "src/tracked.ts", "export const tracked=1\n");
    write(root, "tests/untracked.ts", "export const untracked=2\n");
    write(root, "docs/generated.md", "# generated\n");
    write(root, "scratch/ignored.ts", "export const ignored=3\n");
    write(root, ".claude/settings.local.json", '{"personal":true}\n');
    write(root, "notes.bin", "not a supported parser\n");
    execFileSync(
      "git",
      ["add", ".gitignore", ".prettierignore", "src/tracked.ts"],
      { cwd: root },
    );

    await expect(runner.collectPrettierInventory({ root })).resolves.toEqual([
      "src/tracked.ts",
      "tests/untracked.ts",
    ]);
  });

  it("fails closed for an eligible file in an unreviewed top-level directory", async () => {
    const root = createGitRepository();
    write(root, ".prettierignore", "");
    write(root, "src/tracked.ts", "export const tracked=1\n");
    write(root, "experiment/config.json", "{}\n");
    execFileSync("git", ["add", ".prettierignore", "src/tracked.ts"], {
      cwd: root,
    });

    await expect(runner.collectPrettierInventory({ root })).rejects.toThrow(
      /unreviewed top-level directories:[\s\S]*- experiment/,
    );
  });

  it("fails closed for a dangling worktree symbolic link", async () => {
    const root = createGitRepository();
    write(root, ".prettierignore", "");

    await expect(
      runner.collectPrettierInventory({
        root,
        listFiles: () => ["src/linked.ts"],
        lstat: (path) => ({
          isFile: () => false,
          isSymbolicLink: () => path.endsWith("linked.ts"),
        }),
      }),
    ).rejects.toThrow(/refuses symbolic links: src\/linked\.ts/);
  });

  it("fails closed instead of traversing an ancestor junction", async () => {
    const root = createGitRepository();
    write(root, ".prettierignore", "");

    await expect(
      runner.collectPrettierInventory({
        root,
        listFiles: () => ["src/linked.ts"],
        lstat: (path) => ({
          isFile: () => path.endsWith("linked.ts"),
          isSymbolicLink: () => path.endsWith("src"),
        }),
      }),
    ).rejects.toThrow(/refuses symbolic links: src\/linked\.ts/);
  });

  it("checks and writes both tracked and non-ignored untracked files", async () => {
    const root = createGitRepository();
    write(root, ".gitignore", "scratch/\n");
    write(root, ".prettierignore", "");
    write(root, "src/tracked.ts", "export const tracked={a:1,b:2}\n");
    write(root, "tests/untracked.ts", "export const untracked = 2;\n");
    execFileSync(
      "git",
      ["add", ".gitignore", ".prettierignore", "src/tracked.ts"],
      { cwd: root },
    );
    const inventory = await runner.collectPrettierInventory({ root });

    expect(runner.runPrettier("check", inventory, { root })).toBe(1);
    expect(runner.runPrettier("write", inventory, { root })).toBe(0);
    expect(runner.runPrettier("check", inventory, { root })).toBe(0);

    write(root, "tests/untracked.ts", "export const untracked={a:1,b:2}\n");
    expect(runner.runPrettier("check", inventory, { root })).toBe(1);
  });

  it("retains root files while enforcing reviewed directory ownership", () => {
    expect(
      runner.assertAuthoritativePaths([
        "package.json",
        "src/main/index.ts",
        "third_party/fonts/manifest.json",
      ]),
    ).toEqual([
      "package.json",
      "src/main/index.ts",
      "third_party/fonts/manifest.json",
    ]);
    expect(() =>
      runner.assertAuthoritativePaths(["private/config.json"]),
    ).toThrow(/- private/);
  });

  it("explicitly recognizes machine-local Claude settings", () => {
    expect(runner.isPersonalLocalFile(".claude/settings.local.json")).toBe(
      true,
    );
    expect(runner.isPersonalLocalFile(".claude/settings.json")).toBe(false);
  });
});

describe("run-prettier command contract", () => {
  it("accepts exactly one write or check mode", () => {
    expect(runner.parseCliMode(["--check"])).toBe("check");
    expect(runner.parseCliMode(["--write"])).toBe("write");
    expect(() => runner.parseCliMode([])).toThrow(/--check\|--write/);
    expect(() => runner.parseCliMode(["--check", "--write"])).toThrow(
      /--check\|--write/,
    );
  });

  it("batches exact paths below a conservative command-line budget", () => {
    expect(
      runner.buildPathBatches(["src/a.ts", "src/b.ts", "tests/c.ts"], 20),
    ).toEqual([["src/a.ts"], ["src/b.ts"], ["tests/c.ts"]]);
  });
});

function createGitRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "manga-prettier-test-"));
  temporaryDirectories.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function write(root: string, relativePath: string, contents: string): void {
  const target = join(root, relativePath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents, "utf8");
}
