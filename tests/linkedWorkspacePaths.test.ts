import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  cleanupLinkedWorkspaceTemporaryFiles,
  normalizeLinkedRelativePath,
  relativePathFromRoot,
  resolveLinkedPngArtifactPath,
  resolveLinkedResultPath,
  resolvePathInside,
  writeBinaryFileAtomically,
} from "../src/main/linkedWorkspace/linkedWorkspacePaths";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("linked workspace paths", () => {
  it("rejects absolute paths and every traversal segment", () => {
    expect(() => normalizeLinkedRelativePath("../outside.png")).toThrow();
    expect(() =>
      normalizeLinkedRelativePath("nested/../outside.png"),
    ).toThrow();
    expect(() => normalizeLinkedRelativePath("/outside.png")).toThrow();
    expect(() => normalizeLinkedRelativePath("C:\\outside.png")).toThrow();
  });

  it("keeps nested source names and resolves source-format fallbacks", async () => {
    const root = await makeTempDir();
    const jpeg = resolveLinkedResultPath({
      rootPath: root,
      sourceRelativePath: "1화/001.JPEG",
      format: "source",
    });
    const fallback = resolveLinkedResultPath({
      rootPath: root,
      sourceRelativePath: "2화/002.bmp",
      format: "source",
    });

    expect(jpeg.captureFormat).toBe("jpeg");
    expect(relative(root, jpeg.path).replaceAll("\\", "/")).toBe(
      "result/1화/001.jpeg",
    );
    expect(fallback.captureFormat).toBe("png");
    expect(relative(root, fallback.path).replaceAll("\\", "/")).toBe(
      "result/2화/002.png",
    );
  });

  it("disambiguates equal stems with different source extensions", async () => {
    const root = await makeTempDir();
    const jpg = resolveLinkedPngArtifactPath({
      rootPath: root,
      directory: "mask",
      sourceRelativePath: "nested/a.jpg",
      disambiguateExtension: true,
    });
    const png = resolveLinkedPngArtifactPath({
      rootPath: root,
      directory: "mask",
      sourceRelativePath: "nested/a.png",
      disambiguateExtension: true,
    });
    expect(relativePathFromRoot(root, jpg)).toBe("mask/nested/a.jpg.png");
    expect(relativePathFromRoot(root, png)).toBe("mask/nested/a.png.png");
  });

  it("publishes atomically and removes interrupted managed temp files", async () => {
    const root = await makeTempDir();
    const target = resolvePathInside(root, "result/nested/page.png");
    await writeBinaryFileAtomically(target, Buffer.from("first"));
    await writeBinaryFileAtomically(target, Buffer.from("second"));
    expect(await readFile(target, "utf8")).toBe("second");

    const rejected = resolvePathInside(root, "result/rejected.png");
    await expect(
      writeBinaryFileAtomically(rejected, Buffer.from("partial"), () => {
        throw new Error("stale revision");
      }),
    ).rejects.toThrow("stale revision");
    expect(
      await readdir(
        resolvePathInside(root, "result/.probe").replace(/[\\/]\.probe$/, ""),
      ),
    ).not.toContain("rejected.png");

    const interrupted = resolvePathInside(
      root,
      "result/.page.png.123.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.tmp",
    );
    const ordinary = resolvePathInside(root, "result/user.tmp");
    await writeFile(interrupted, "partial");
    await writeFile(ordinary, "keep");
    await cleanupLinkedWorkspaceTemporaryFiles(root);
    expect(
      await readdir(
        resolvePathInside(root, "result/.probe").replace(/[\\/]\.probe$/, ""),
      ),
    ).toContain("user.tmp");
    expect(
      await readdir(
        resolvePathInside(root, "result/.probe").replace(/[\\/]\.probe$/, ""),
      ),
    ).not.toContain(".page.png.123.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.tmp");
  });
});

async function makeTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mgt-linked-paths-"));
  tempDirs.push(path);
  return path;
}
