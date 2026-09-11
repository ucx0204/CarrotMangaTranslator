import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readRedactionWorkspaceStore,
  updateRedactionWorkspaceStore,
} from "../src/main/imageRedactionWorkspaceStore";
import {
  emptyRedactionDraft,
  redactionWorkspaceIndexSchema,
  retainRedactionViews,
} from "../src/main/imageRedactionWorkspaceIndex";
import {
  readRedactionSnapshot,
  writeRedactionSnapshot,
} from "../src/main/imageRedactionWorkspaceSnapshot";
import {
  persistRedactionRecord,
  redactionObjectHash,
  REDACTION_INDEX_FILE,
  REDACTION_OBJECT_DIRECTORY,
} from "../src/main/imageRedactionWorkspaceObjects";
import { DEFAULT_REDACTION_VIEW } from "../src/shared/imageRedactionWorkspace";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "redaction-shards-"));
  roots.push(root);
  return root;
}
function page(character = "a") {
  return {
    fingerprint: character.repeat(64),
    strokes: [],
    decision: "reviewed" as const,
    width: 20,
    height: 20,
  };
}
async function index(root: string) {
  return redactionWorkspaceIndexSchema.parse(
    JSON.parse(await readFile(join(root, REDACTION_INDEX_FILE), "utf8")),
  );
}
it("migrates all legacy pages on write, preserves raw backup and never rewrites a draft just by opening", async () => {
  const root = await directory();
  const legacy = {
    ...emptyRedactionDraft(),
    revision: 7,
    pages: { a: page(), b: page("b") },
    views: { other: DEFAULT_REDACTION_VIEW },
  };
  const bytes = Buffer.from(JSON.stringify(legacy));
  await writeFile(join(root, REDACTION_INDEX_FILE), bytes);
  await readRedactionWorkspaceStore(root, { paths: ["a"], scopeKey: "active" });
  expect(await readFile(join(root, REDACTION_INDEX_FILE))).toEqual(bytes);
  const revision = await updateRedactionWorkspaceStore(
    root,
    async (state) => {
      state.pages.a.decision = "unreviewed";
    },
    { paths: ["a"], scopeKey: "active" },
  );
  expect(revision).toBe(8);
  expect(
    await readFile(
      join(
        root,
        REDACTION_OBJECT_DIRECTORY,
        `legacy-${redactionObjectHash(bytes)}.json`,
      ),
    ),
  ).toEqual(bytes);
  const saved = await readRedactionWorkspaceStore(root);
  expect(saved.pages.b).toEqual(legacy.pages.b);
  expect(saved.pages.a.decision).toBe("unreviewed");
  expect(saved.views.other).toEqual(DEFAULT_REDACTION_VIEW);
  expect((await index(root)).pages.a).toMatch(/^[a-f0-9]{64}$/);
});
it("loads only requested pages and preserves an unrelated record during a view-only save", async () => {
  const root = await directory();
  await updateRedactionWorkspaceStore(root, async (state) => {
    state.pages = { a: page(), b: page("b") };
  });
  const before = await index(root);
  await writeFile(
    join(root, REDACTION_OBJECT_DIRECTORY, `${before.pages.b}.json`),
    "corrupt",
  );
  const selected = await readRedactionWorkspaceStore(root, {
    paths: ["a"],
    scopeKey: "active",
  });
  expect(Object.keys(selected.pages)).toEqual(["a"]);
  await expect(readRedactionWorkspaceStore(root)).rejects.toThrow("손상");
  await updateRedactionWorkspaceStore(
    root,
    async (state) => {
      state.views.active = DEFAULT_REDACTION_VIEW;
    },
    { paths: [], scopeKey: "active" },
  );
  expect((await index(root)).pages).toEqual(before.pages);
  await expect(
    readRedactionWorkspaceStore(root, { paths: ["b"], scopeKey: "active" }),
  ).rejects.toThrow("손상");
});
it("keeps the previous index and all acknowledged pages when publication fails after writing objects", async () => {
  const root = await directory();
  await updateRedactionWorkspaceStore(root, async (state) => {
    state.pages.a = page();
  });
  const before = await readFile(join(root, REDACTION_INDEX_FILE));
  const snapshot = await readRedactionSnapshot(root);
  snapshot.state.pages.a.decision = "unreviewed";
  const failure = new Error("index write refused");
  await expect(
    writeRedactionSnapshot(root, snapshot, async (path, bytes) => {
      if (basename(path) === REDACTION_INDEX_FILE) throw failure;
      await persistRedactionRecord(path, bytes);
    }),
  ).rejects.toBe(failure);
  expect(await readFile(join(root, REDACTION_INDEX_FILE))).toEqual(before);
  expect((await readRedactionWorkspaceStore(root)).pages.a.decision).toBe(
    "reviewed",
  );
  await updateRedactionWorkspaceStore(root, async (state) => {
    state.pages.a.decision = "unreviewed";
  });
  expect((await readRedactionWorkspaceStore(root)).revision).toBe(2);
});
it("reuses immutable objects on unchanged saves and never treats missing referenced objects as an empty store", async () => {
  const root = await directory();
  await updateRedactionWorkspaceStore(root, async (state) => {
    state.pages.a = page();
  });
  const objects = await readdir(join(root, REDACTION_OBJECT_DIRECTORY));
  await updateRedactionWorkspaceStore(root, async () => {});
  expect(await readdir(join(root, REDACTION_OBJECT_DIRECTORY))).toEqual(
    objects,
  );
  const current = await index(root);
  await rm(join(root, REDACTION_OBJECT_DIRECTORY, `${current.pages.a}.json`));
  await expect(readRedactionWorkspaceStore(root)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect((await index(root)).revision).toBe(2);
});
it("bounds only cached view positions without expiring page masks or following a reference outside the private folder", async () => {
  const views = Object.fromEntries(
    Array.from({ length: 1025 }, (_, i) => [
      String(i),
      { object: "a".repeat(64), touched: i },
    ]),
  );
  expect(Object.keys(retainRedactionViews(views))).toHaveLength(1024);
  expect(retainRedactionViews(views)["0"]).toBeUndefined();
  expect(retainRedactionViews(views)["1024"]).toBeDefined();
  const root = await directory();
  await updateRedactionWorkspaceStore(root, async (state) => {
    state.pages.a = page();
  });
  const current = await index(root);
  await writeFile(
    join(root, REDACTION_INDEX_FILE),
    JSON.stringify({ ...current, pages: { a: "../../image.png" } }),
  );
  await expect(readRedactionWorkspaceStore(root)).rejects.toThrow();
});
