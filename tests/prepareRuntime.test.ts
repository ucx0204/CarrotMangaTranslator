import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type PrepareRuntimeModule = {
  prepareRuntimeAssets: (options: {
    root: string;
    outputDir?: string;
  }) => string;
};

const { prepareRuntimeAssets } =
  require("../scripts/prepare-runtime.cjs") as PrepareRuntimeModule;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    removeDirectoryTree(directory);
  }
});

function removeDirectoryTree(directory: string): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removeDirectoryTree(entryPath);
      continue;
    }
    unlinkSync(entryPath);
  }
  rmdirSync(directory);
}

function createRuntimeFixture() {
  const root = mkdtempSync(join(tmpdir(), "prepare-runtime-"));
  temporaryDirectories.push(root);
  const sourceDir = join(root, "src", "main", "runtime");
  mkdirSync(join(sourceDir, "transport"), { recursive: true });
  mkdirSync(join(sourceDir, "templates"), { recursive: true });
  writeFileSync(join(sourceDir, "root.cjs"), "root");
  writeFileSync(
    join(sourceDir, "paddleocr_review_contexts.py"),
    "def build_textline_review_context_ids(partition): return {}",
  );
  writeFileSync(join(sourceDir, "transport", "response.cjs"), "nested");
  writeFileSync(join(sourceDir, "templates", "chat-template.jinja"), "jinja");
  return { root, sourceDir };
}

describe("prepareRuntimeAssets", () => {
  it("replaces stale output and recursively copies runtime modules", () => {
    const { root } = createRuntimeFixture();
    const outputDir = join(root, "out", "app-runtime");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "stale.cjs"), "stale");

    expect(prepareRuntimeAssets({ root, outputDir })).toBe(outputDir);

    expect(existsSync(join(outputDir, "stale.cjs"))).toBe(false);
    expect(readFileSync(join(outputDir, "root.cjs"), "utf8")).toBe("root");
    expect(
      readFileSync(join(outputDir, "paddleocr_review_contexts.py"), "utf8"),
    ).toContain("build_textline_review_context_ids");
    expect(
      readFileSync(join(outputDir, "transport", "response.cjs"), "utf8"),
    ).toBe("nested");
    expect(
      readFileSync(join(outputDir, "templates", "chat-template.jinja"), "utf8"),
    ).toBe("jinja");
  });

  it("refuses to clean the project root or any runtime source path", () => {
    const { root, sourceDir } = createRuntimeFixture();

    expect(() => prepareRuntimeAssets({ root, outputDir: root })).toThrow(
      /unsafe runtime output/,
    );
    expect(() => prepareRuntimeAssets({ root, outputDir: sourceDir })).toThrow(
      /unsafe runtime output/,
    );
    expect(() =>
      prepareRuntimeAssets({ root, outputDir: join(root, "src", "main") }),
    ).toThrow(/unsafe runtime output/);

    expect(readFileSync(join(sourceDir, "root.cjs"), "utf8")).toBe("root");
  });

  it("does not replace a non-directory output target", () => {
    const { root } = createRuntimeFixture();
    const outputFile = join(root, "runtime-output");
    writeFileSync(outputFile, "keep-me");

    expect(() => prepareRuntimeAssets({ root, outputDir: outputFile })).toThrow(
      /must be a real directory/,
    );
    expect(readFileSync(outputFile, "utf8")).toBe("keep-me");
  });
});
