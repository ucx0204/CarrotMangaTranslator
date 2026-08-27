import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  FORBIDDEN_GITHUB_PATH_PATTERNS,
  isForbiddenRepositoryPath,
  normalizeRepositoryPath,
} = require("../scripts/private-workspace-policy.cjs") as {
  FORBIDDEN_GITHUB_PATH_PATTERNS: readonly string[];
  isForbiddenRepositoryPath: (path: string) => boolean;
  normalizeRepositoryPath: (path: string) => string;
};

describe("private workspace repository policy", () => {
  it.each([
    "results/work/chapter/originals/01.webp",
    "library/work.json",
    "logs/app.log",
    ".settings-pairs/generation/settings.json",
    "codex/auth.json",
    ".codex-workspace/AGENTS.md",
    "settings.secrets.json",
    "block-library.json",
    "linked-workspaces.json",
    ".mgt-instance-candidate-123/owner.json",
    ".claude/settings.local.json",
  ])("rejects %s", (path) => {
    expect(isForbiddenRepositoryPath(path)).toBe(true);
  });

  it.each([
    "src/main/settingsStore.ts",
    "settings.example.json",
    "docs/release-notes/v1.20.1.md",
    "src/renderer/assets/fonts/font-manifest.json",
  ])("allows %s", (path) => {
    expect(isForbiddenRepositoryPath(path)).toBe(false);
  });

  it("normalizes Windows paths and exports remote push restrictions", () => {
    expect(normalizeRepositoryPath(".\\results\\work\\01.webp")).toBe(
      "results/work/01.webp",
    );
    expect(FORBIDDEN_GITHUB_PATH_PATTERNS).toContain("results/**/*");
    expect(FORBIDDEN_GITHUB_PATH_PATTERNS).toContain("settings.secrets.json");
    expect(FORBIDDEN_GITHUB_PATH_PATTERNS).toContain("codex/**/*");
    expect(new Set(FORBIDDEN_GITHUB_PATH_PATTERNS).size).toBe(
      FORBIDDEN_GITHUB_PATH_PATTERNS.length,
    );
  });

  it("rejects a forbidden file that existed only in an intermediate pushed commit", () => {
    const root = join(
      tmpdir(),
      `mgt-private-push-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init");
      git(root, "config", "user.email", "test@example.invalid");
      git(root, "config", "user.name", "Private workspace guard test");
      writeFileSync(join(root, "safe.txt"), "safe\n", "utf8");
      git(root, "add", "safe.txt");
      git(root, "commit", "-m", "safe root");
      mkdirSync(join(root, "results"));
      writeFileSync(join(root, "results", "private.txt"), "private\n", "utf8");
      git(root, "add", "-f", "results/private.txt");
      git(root, "commit", "-m", "forbidden intermediate");
      rmSync(join(root, "results"), { recursive: true, force: true });
      git(root, "add", "-u");
      git(root, "commit", "-m", "remove forbidden file");
      const localSha = git(root, "rev-parse", "HEAD").trim();
      const result = spawnSync(
        process.execPath,
        [
          join(__dirname, "..", "scripts", "check-private-workspace-files.cjs"),
          "--pre-push",
          "--root",
          root,
        ],
        {
          cwd: root,
          encoding: "utf8",
          input: `refs/heads/test ${localSha} refs/heads/test ${"0".repeat(40)}\n`,
          windowsHide: true,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("results/private.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}
