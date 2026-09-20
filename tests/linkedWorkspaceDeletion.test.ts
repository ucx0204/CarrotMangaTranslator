import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import type { LinkedWorkspaceRecordV1 } from "../src/shared/linkedWorkspaceTypes";
import { DEFAULT_RASTER_EXPORT_SETTINGS } from "../src/shared/linkedWorkspaceTypes";
import { fingerprintFile } from "../src/main/linkedWorkspace/linkedWorkspaceFiles";
import {
  deleteLinkedWorkspaceFiles,
  isTrustedDarwinSystemAlias,
  recoverLinkedWorkspaceDeletions,
} from "../src/main/linkedWorkspace/linkedWorkspaceDeletion";
import { buildLinkedMirrorFileName } from "../src/main/linkedWorkspace/linkedWorkspacePaths";

const roots: string[] = [];

it.each(["/var", "/tmp", "/etc"])(
  "accepts only the exact root-owned Darwin system alias %s",
  (path) => {
    expect(
      isTrustedDarwinSystemAlias(path, `/private${path}`, "darwin", 0),
    ).toBe(true);
    expect(isTrustedDarwinSystemAlias(path, "/elsewhere", "darwin", 0)).toBe(
      false,
    );
    expect(
      isTrustedDarwinSystemAlias(path, `/private${path}`, "darwin", 501),
    ).toBe(false);
    expect(
      isTrustedDarwinSystemAlias(path, `/private${path}`, "win32", 0),
    ).toBe(false);
    expect(
      isTrustedDarwinSystemAlias(path, `/private${path}`, "linux", 0),
    ).toBe(false);
  },
);

it("rejects user-defined aliases even on Darwin", () => {
  expect(
    isTrustedDarwinSystemAlias(
      "/Users/shared",
      "/private/Users/shared",
      "darwin",
      0,
    ),
  ).toBe(false);
});
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "manga-output-deletion-"));
  roots.push(dataRoot);
  const root = join(dataRoot, "results", "work", "chapter");
  await mkdir(join(root, "result"), { recursive: true });
  const path = join(root, "result", "page.png");
  await writeFile(path, "generated pixels");
  const hash = await fingerprintFile(path);
  const pageId = randomUUID();
  const record: LinkedWorkspaceRecordV1 = {
    id: randomUUID(),
    chapterId: randomUUID(),
    workId: randomUUID(),
    rootPath: root,
    destinationKind: "managed",
    enabled: true,
    output: DEFAULT_RASTER_EXPORT_SETTINGS,
    pageRelativePaths: { [pageId]: "page.png" },
    sourceFingerprints: {},
    publishedRevisions: {},
    publishedMirrorRevisions: {},
    artifacts: {
      [pageId]: {
        result: {
          path: "result/page.png",
          bytes: hash.size,
          sha256: hash.sha256,
        },
      },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const options = {
    dataRoot,
    records: [record],
    allRecords: [record],
    removeCustom: false,
    deleteLibrary: async () => true,
    forgetRecords: async () => {},
  };
  return { dataRoot, root, path, record, pageId, options };
}

it("removes an empty managed output directory but retains an externally modified result", async () => {
  const first = await fixture();
  await deleteLinkedWorkspaceFiles(first.options);
  await expect(access(first.root)).rejects.toMatchObject({ code: "ENOENT" });
  const second = await fixture();
  await writeFile(second.path, "user edited pixels");
  await deleteLinkedWorkspaceFiles(second.options);
  expect(await readFile(second.path, "utf8")).toBe("user edited pixels");
});

it("requires opt-in for custom generated files and keeps unrelated custom files", async () => {
  const value = await fixture();
  value.record.destinationKind = "custom";
  await writeFile(join(value.root, "original.png"), "external original");
  await deleteLinkedWorkspaceFiles(value.options);
  expect(await readFile(value.path, "utf8")).toBe("generated pixels");
  await deleteLinkedWorkspaceFiles({ ...value.options, removeCustom: true });
  await expect(access(value.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(value.root, "original.png"), "utf8")).toBe(
    "external original",
  );
});

it("keeps files and mirror chapters owned by a different connection in the same root", async () => {
  const value = await fixture();
  const other = {
    ...value.record,
    id: randomUUID(),
    chapterId: randomUUID(),
    workId: randomUUID(),
  };
  const mirrorPath = join(value.root, buildLinkedMirrorFileName(value.root));
  await writeFile(
    mirrorPath,
    JSON.stringify({
      schemaVersion: 1,
      chapters: [{ id: value.record.chapterId }, { id: other.chapterId }],
    }),
  );
  await deleteLinkedWorkspaceFiles({
    ...value.options,
    allRecords: [value.record, other],
  });
  expect(await readFile(value.path, "utf8")).toBe("generated pixels");
  expect(JSON.parse(await readFile(mirrorPath, "utf8")).chapters).toEqual([
    { id: other.chapterId },
  ]);
});

it.each([false, true])(
  "recovers an interrupted deletion according to committed library state: %s",
  async (committed) => {
    const value = await fixture();
    const id = randomUUID();
    const staged = `${value.path}.manga-delete-${id}`;
    const directory = join(value.dataRoot, "linked-deletions");
    await mkdir(directory);
    await writeFile(
      join(directory, `${id}.json`),
      JSON.stringify({
        id,
        chapterIds: [value.record.chapterId],
        recordIds: [value.record.id],
        files: [{ root: value.root, path: value.path, staged }],
      }),
    );
    await rename(value.path, staged);
    const forgotten: string[] = [];
    await recoverLinkedWorkspaceDeletions({
      dataRoot: value.dataRoot,
      chapterExists: async () => !committed,
      forgetRecords: async (ids) => {
        forgotten.push(...ids);
      },
    });
    expect(await readdir(directory)).toEqual([]);
    if (committed) {
      expect(forgotten).toEqual([value.record.id]);
      await expect(access(value.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } else {
      expect(forgotten).toEqual([]);
      expect(await readFile(value.path, "utf8")).toBe("generated pixels");
    }
  },
);

it("refuses junction traversal before changing library data or external files", async () => {
  const value = await fixture();
  const external = join(value.dataRoot, "external");
  await mkdir(external);
  await writeFile(join(external, "keep.png"), "external");
  const link = join(value.root, "linked");
  await symlink(external, link, "junction");
  const hash = await fingerprintFile(join(external, "keep.png"));
  value.record.artifacts[value.pageId] = {
    result: { path: "linked/keep.png", bytes: hash.size, sha256: hash.sha256 },
  };
  let deleted = false;
  try {
    await expect(
      deleteLinkedWorkspaceFiles({
        ...value.options,
        deleteLibrary: async () => {
          deleted = true;
          return true;
        },
      }),
    ).rejects.toThrow("연결된 경로");
    expect(deleted).toBe(false);
    expect(await readFile(join(external, "keep.png"), "utf8")).toBe("external");
  } finally {
    await rm(link);
  }
});

it("preserves a shared mirror's file even when the other chapter is not connected", async () => {
  const value = await fixture();
  const otherId = randomUUID();
  const mirrorPath = join(value.root, buildLinkedMirrorFileName(value.root));
  const other = {
    id: otherId,
    pages: [{ result: { path: "result/page.png" } }],
  };
  await writeFile(
    mirrorPath,
    JSON.stringify({
      schemaVersion: 1,
      chapters: [{ id: value.record.chapterId }, other],
    }),
  );
  await deleteLinkedWorkspaceFiles(value.options);
  expect(await readFile(value.path, "utf8")).toBe("generated pixels");
  expect(JSON.parse(await readFile(mirrorPath, "utf8")).chapters).toEqual([
    other,
  ]);
});

it("keeps a new external file written at the original path during deletion", async () => {
  const value = await fixture();
  await deleteLinkedWorkspaceFiles({
    ...value.options,
    deleteLibrary: async () => {
      await writeFile(value.path, "new user file");
      return true;
    },
  });
  expect(await readFile(value.path, "utf8")).toBe("new user file");
});
