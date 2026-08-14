import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const metadataIo = vi.hoisted(() => ({
  renames: [] as Array<[source: string, destination: string]>,
  removals: [] as string[],
  writes: [] as string[],
}));

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return {
    ...actual,
    rename: async (source: string, destination: string) => {
      metadataIo.renames.push([source, destination]);
      return actual.rename(source, destination);
    },
    rm: async (filePath: string, options?: Parameters<typeof actual.rm>[1]) => {
      metadataIo.removals.push(filePath);
      return actual.rm(filePath, options);
    },
    writeFile: async (
      filePath: string,
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ) => {
      metadataIo.writes.push(filePath);
      return actual.writeFile(filePath, data, options);
    },
  };
});
import {
  findFilesRecursive,
  findFirstFileRecursive,
  writeRemoteFileMetadata,
} from "../src/main/runtimeSupport/fileProbe";

const {
  findMatchingFile,
  findNamedFile,
}: {
  findMatchingFile: (
    root: string,
    predicate: (name: string, fullPath: string) => boolean,
    maxDepth?: number,
  ) => string | null;
  findNamedFile: (
    root: string,
    expectedName: string,
    maxDepth?: number,
  ) => string | null;
} = require("../src/main/runtime/simple-page-file-search.cjs");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
  metadataIo.renames.length = 0;
  metadataIo.removals.length = 0;
  metadataIo.writes.length = 0;
});

describe("file probe BFS cores", () => {
  it("preserves TS depth, ignored-directory, and result-limit behavior", async () => {
    const root = await createTree();
    const nestedTarget = join(root, "nested", "TARGET.DLL");

    expect(findFirstFileRecursive(root, new Set(["target.dll"]), 0)).toBeNull();
    expect(findFirstFileRecursive(root, new Set(["target.dll"]), 1)).toBe(
      nestedTarget,
    );
    expect(
      findFirstFileRecursive(root, new Set(["ignored.dll"]), 4),
    ).toBeNull();

    const matches = findFilesRecursive(
      root,
      (entry) => entry.name.toLowerCase().endsWith(".dll"),
      4,
      1,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(nestedTarget);
    expect(
      findFilesRecursive(
        root,
        (entry) => entry.isDirectory() && entry.name === "nested",
        0,
        1,
      ),
    ).toEqual([join(root, "nested")]);
    expect(findFilesRecursive(root, () => true, 4, 0)).toEqual([]);
  });

  it("preserves standalone CJS name, predicate, and depth behavior", async () => {
    const root = await createTree();
    const nestedTarget = join(root, "nested", "TARGET.DLL");

    expect(findNamedFile(root, "TARGET.DLL", 0)).toBeNull();
    expect(findNamedFile(root, "TARGET.DLL", 1)).toBe(nestedTarget);
    expect(
      findMatchingFile(root, (name) => name.toLowerCase() === "target.dll", 1),
    ).toBe(nestedTarget);
    expect(findMatchingFile(root, () => false, 4)).toBeNull();
  });

  it("publishes remote metadata through a compact same-directory temp file", async () => {
    const root = await mkdtemp(join(tmpdir(), "mgt-metadata-path-"));
    roots.push(root);
    const filePath = join(root, "download.bin");
    const metadataPath = `${filePath}.mgtmeta.json`;
    metadataIo.renames.length = 0;
    metadataIo.removals.length = 0;
    metadataIo.writes.length = 0;

    await writeRemoteFileMetadata(filePath, {
      url: "https://example.invalid/download.bin",
      bytes: 8,
      downloadedAt: "2026-08-14T00:00:00.000Z",
    });

    const temporaryPath = metadataIo.writes.find(
      (candidate) => dirname(candidate) === root,
    );
    expect(temporaryPath).toBeDefined();
    if (!temporaryPath) throw new Error("Metadata temporary path was not used");
    expect(dirname(temporaryPath)).toBe(dirname(metadataPath));
    expect(basename(temporaryPath)).toMatch(/^\.m-[a-f0-9]{16}$/);
    expect(metadataIo.renames).toContainEqual([temporaryPath, metadataPath]);
    expect(metadataIo.removals).toContain(temporaryPath);
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({
      bytes: 8,
      url: "https://example.invalid/download.bin",
    });
    expect((await readdir(root)).some((name) => /^\.m-/.test(name))).toBe(
      false,
    );
  });
});

async function createTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mgt-file-probe-"));
  roots.push(root);
  await mkdir(join(root, "nested"));
  await mkdir(join(root, "__pycache__"));
  await writeFile(join(root, "nested", "TARGET.DLL"), "target");
  await writeFile(join(root, "__pycache__", "ignored.dll"), "ignored");
  return root;
}
