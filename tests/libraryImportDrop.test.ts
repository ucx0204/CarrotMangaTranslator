import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyDroppedImportPaths } from "../src/main/library/libraryImportDrop";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

describe("dropped library import classification", () => {
  it("accepts multiple supported image files as one image import", async () => {
    const root = await makeTempDir();
    const first = await makeFile(root, "001.PNG");
    const second = await makeFile(root, "002.webp");

    await expect(
      classifyDroppedImportPaths([first, second, first]),
    ).resolves.toEqual({
      status: "accepted",
      kind: "images",
      filePaths: [first, second],
    });
  });

  it("accepts one folder or one ZIP/CBZ archive", async () => {
    const root = await makeTempDir();
    const folder = join(root, "pages");
    await mkdir(folder);
    const zip = await makeFile(root, "chapter.CBZ");

    await expect(classifyDroppedImportPaths([folder])).resolves.toEqual({
      status: "accepted",
      kind: "folder",
      folderPath: folder,
    });
    await expect(classifyDroppedImportPaths([zip])).resolves.toEqual({
      status: "accepted",
      kind: "archive",
      archivePath: zip,
    });
  });

  it("rejects a folder mixed with any other item", async () => {
    const root = await makeTempDir();
    const folder = join(root, "pages");
    await mkdir(folder);
    const image = await makeFile(root, "001.png");

    await expect(
      classifyDroppedImportPaths([folder, image]),
    ).resolves.toMatchObject({
      status: "rejected",
      reason: "folder-must-be-alone",
      count: 2,
    });
  });

  it("rejects an archive mixed with any other item", async () => {
    const root = await makeTempDir();
    const archive = await makeFile(root, "chapter.zip");
    const image = await makeFile(root, "001.jpg");

    await expect(
      classifyDroppedImportPaths([image, archive]),
    ).resolves.toMatchObject({
      status: "rejected",
      reason: "archive-must-be-alone",
      count: 2,
    });
  });

  it("rejects an unsupported file without partially importing images", async () => {
    const root = await makeTempDir();
    const image = await makeFile(root, "001.jpeg");
    const notes = await makeFile(root, "notes.txt");

    await expect(classifyDroppedImportPaths([image, notes])).resolves.toEqual({
      status: "rejected",
      reason: "unsupported-files",
      count: 1,
      names: ["notes.txt"],
    });
  });

  it("reports missing and relative paths as unsupported inputs", async () => {
    const root = await makeTempDir();
    const missing = join(root, "missing.png");

    await expect(
      classifyDroppedImportPaths([missing, "relative.png"]),
    ).resolves.toMatchObject({
      status: "rejected",
      reason: "unsupported-files",
      count: 2,
      names: ["missing.png", "relative.png"],
    });
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "library-import-drop-"));
  tempDirs.push(dir);
  return dir;
}

async function makeFile(root: string, name: string): Promise<string> {
  const filePath = join(root, name);
  await writeFile(filePath, "fixture");
  return filePath;
}
