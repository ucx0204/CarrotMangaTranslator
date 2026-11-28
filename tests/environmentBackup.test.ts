import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { existsSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import * as appPaths from "../src/main/appPaths";
import { listLibrary } from "../src/main/library/libraryReadFacade";
import { readWorkStyleGuide } from "../src/main/libraryStore/workContextFiles";
import type { LibraryChapter } from "../src/shared/libraryTypes";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import {
  commitSettingsPair,
  loadSettingsSecrets,
} from "../src/main/settingsSecretStore";
import { EnvironmentBackupStore } from "../src/main/environmentBackup/store";
import {
  backupWorkspace,
  createBackupStage,
  recoveryPath,
  recoverEnvironmentRestore,
  scheduleEnvironmentRestore,
  stagePath,
} from "../src/main/environmentBackup/transaction";
import {
  RESTORE_NAMES,
  backupRelativePath,
} from "../src/main/environmentBackup/policy";
import {
  hashBackupFile,
  regularFiles,
} from "../src/main/environmentBackup/files";
import {
  extractBackupArchive,
  writeBackupArchive,
} from "../src/main/environmentBackup/archive";
import { relocateCopiedChapterImagePath } from "../src/main/libraryStore/chapterImageRelocation";
import { createPageRevision } from "../src/shared/pageRevision";
import { copyCategories } from "../src/main/environmentBackup/snapshot";
import { BACKUP_SOURCE_NAMES } from "../src/main/environmentBackup/policy";
import { PageWorkflowPlanSchema } from "../src/shared/pageWorkflowTypes";
import { workflowStageKey } from "../src/shared/pageWorkflowPolicy";
import { relocateBackupWorkflow } from "../src/main/environmentBackup/workflow";
import type { LibraryPageRecord } from "../src/shared/libraryTypes";
import { clipboardBlock } from "./fixtures/blockClipboard";
import {
  readRedactionSnapshot,
  writeRedactionSnapshot,
} from "../src/main/imageRedactionWorkspaceSnapshot";
import { emptyRedactionDraft } from "../src/main/imageRedactionWorkspaceIndex";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^sealed:/, ""),
  },
}));
// Keep settings, ZIP bytes and restore transactions real; GPU discovery is host I/O.
// A stalled cached hardware query otherwise blocks all three archive round trips.
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: vi.fn((_file: string, ...args: unknown[]) => {
    const callback = args.at(-1) as (
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    queueMicrotask(() => callback(null, "", ""));
    return {};
  }),
}));
const dirs: string[] = [];
afterEach(async () => {
  for (const directory of dirs.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "carrot-backup-test-"));
  dirs.push(root);
  return root;
}
function paths(root: string): AppPaths {
  return {
    dataRoot: root,
    libraryDir: join(root, "library"),
    settingsPath: join(root, "settings.json"),
    fontsDir: join(root, "fonts"),
    isPackaged: false,
    repoRoot: root,
    executableDir: root,
    resourcesDir: root,
    logsDir: root,
    logFile: join(root, "test.log"),
    runtimeDir: root,
    toolsDir: root,
    ocrRuntimeDir: root,
    llamaRuntimeDir: root,
    llamaServerPath: "",
  };
}
async function put(root: string, path: string, value: unknown) {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(
    target,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}
const signal = () => new AbortController().signal;
const progress = () => undefined;
const fixtureWorkId = "00000000-0000-4000-8000-000000000001";
const fixtureChapterId = "00000000-0000-4000-8000-000000000002";
const fixturePageId = "00000000-0000-4000-8000-000000000003";
const fixtureWork = `library/works/${fixtureWorkId}`;
const fixtureChapter = `${fixtureWork}/chapters/${fixtureChapterId}`;
const chapterPath = `${fixtureChapter}/chapter.json`;
async function fixture(root: string) {
  const stamp = "2026-09-24T00:00:00.000Z";
  await put(root, "library/index.json", { workOrder: [fixtureWorkId] });
  await put(root, `${fixtureWork}/work.json`, {
    id: fixtureWorkId,
    title: "이관 테스트",
    chapterOrder: [fixtureChapterId],
    createdAt: stamp,
    updatedAt: stamp,
  });
  const imagePath = join(root, `${fixtureChapter}/pages/source.png`);
  await put(root, `${fixtureChapter}/pages/source.png`, "original bytes");
  const page = {
    id: fixturePageId,
    name: "원본",
    imagePath,
    width: 100,
    height: 100,
    blocks: [clipboardBlock()],
    inpaintedImagePath: join(root, `${fixtureChapter}/pages/result.png`),
    inpaintMaskPath: join(root, `${fixtureChapter}/pages/mask.png`),
    analysisStatus: "idle" as const,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const checkpoint = {
    schemaVersion: 1,
    pipelineContractVersion: "whole-page-prepared-v1",
    pageId: page.id,
    inputRevision: createPageRevision(page),
    sourceLanguage: "ja",
    targetLanguage: "ko",
    blockMode: "auto",
    savedAt: stamp,
    translationDurationMs: 1,
    prepared: {
      kind: "ready",
      resultKind: "no-text",
      warnings: [],
      blocks: [],
    },
  };
  await put(root, `${fixtureChapter}/pages/result.png`, "inpainted bytes");
  await put(root, `${fixtureChapter}/pages/mask.png`, "mask bytes");
  await writeRedactionSnapshot(root, {
    state: {
      ...emptyRedactionDraft(),
      pages: {
        [imagePath]: {
          fingerprint: "a".repeat(64),
          width: 100,
          height: 100,
          strokes: [],
          decision: "reviewed",
        },
      },
    },
  });
  const checkpointBytes = JSON.stringify(checkpoint);
  await put(
    root,
    `${fixtureChapter}/.translation-checkpoint-test/checkpoint.json`,
    checkpointBytes,
  );
  const savedPage = {
    ...page,
    translationCheckpoint: {
      schemaVersion: 1,
      pipelineContractVersion: "whole-page-prepared-v1",
      artifactPath: ".translation-checkpoint-test/checkpoint.json",
      sha256: createHash("sha256").update(checkpointBytes).digest("hex"),
      byteSize: Buffer.byteLength(checkpointBytes),
      inputRevision: createPageRevision(page),
      sourceLanguage: "ja",
      targetLanguage: "ko",
      blockMode: "auto",
      savedAt: stamp,
    },
  };
  await put(root, chapterPath, {
    id: fixtureChapterId,
    workId: fixtureWorkId,
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: [page.id],
    pages: [savedPage],
    createdAt: stamp,
    updatedAt: stamp,
  });
  await put(root, "fonts/custom.ttf", "font bytes");
  const runId = "11111111-1111-4111-8111-111111111111";
  await put(root, `page-workflows/${runId}.json`, {
    id: runId,
    request: {
      plan: PageWorkflowPlanSchema.parse({ version: 1, stages: ["detect"] }),
      selection: [{ chapterId: randomUUID(), pageIds: [randomUUID()] }],
    },
    rules: {},
  });
  await put(root, "block-library.json", { schemaVersion: 1, entries: [] });
  await put(
    root,
    "batch-edit-schemes.yaml",
    "schemaVersion: 1\nschemes: []\nsequences: []\n",
  );
  await put(root, "linked-workspaces.json", {
    records: [{ rootPath: "D:\\external-originals" }],
  });
  await put(root, "codex/auth.json", "SOURCE_LOGIN_MUST_NOT_TRAVEL");
  await put(root, "hf-cache/model.bin", "MODEL_MUST_NOT_TRAVEL");
  const settings = resolveDefaultAppSettings({}, null);
  settings.api.sessionHeaderEnabled = true;
  settings.api.sessionHeaderName = "x-session";
  settings.api.customProfiles = {
    portable: {
      ...settings.api,
      name: "Portable session",
      sessionHeaderEnabled: true,
      sessionHeaderName: "x-session",
      extraBodyJson: '{"private":"BODY_SECRET"}',
    },
  };
  settings.api.activeCustomProfileId = "portable";
  await commitSettingsPair(
    paths(root),
    { ...settings },
    {
      apiProfiles: {
        custom: { apiKey: "SOURCE_API_KEY" },
        "custom:portable": { apiKey: "SOURCE_PROFILE_KEY" },
      },
    },
  );
  return { imagePath, checkpoint };
}

// v3.8.15 copied every file, but only counted and relocated indexed chapters.
async function writeLegacyLibraryBackup(
  root: string,
  archive: string,
  works: number,
  pages: number,
  damagedPath?: string,
) {
  await put(
    root,
    "portable-settings.json",
    resolveDefaultAppSettings({}, null),
  );
  const paths = [
    "portable-settings.json",
    ...(await regularFiles(join(root, "library"), "library")),
  ];
  const files = await Promise.all(
    paths.map((path) => hashBackupFile(root, path, signal())),
  );
  for (const file of files)
    if (file.path === damagedPath) file.sha256 = "0".repeat(64);
  await writeBackupArchive(
    root,
    archive,
    {
      format: "carrot-environment-backup",
      version: 1,
      appVersion: "3.8.15",
      createdAt: new Date().toISOString(),
      ui: {},
      connections: [],
      files,
      summary: {
        works,
        pages,
        bytes: files.reduce((sum, file) => sum + file.size, 0),
      },
    },
    signal(),
    progress,
  );
}

describe("environment backup", () => {
  it("recovers surviving pages, a raw chapter image and an orphan glossary into the selected work atomically", async () => {
    const source = await temp(),
      target = await temp(),
      archive = join(await temp(), "old.zip");
    await fixture(source);
    await fixture(target);
    await unlink(join(source, `${fixtureWork}/work.json`));
    const glossary = "library/works/terms-only/style-guide.json";
    await put(source, glossary, {
      glossary: [
        { source: "猫", target: "고양이" },
        { source: "魔王", target: "마왕" },
      ],
    });
    const stamp = new Date().toISOString();
    const existing = {
      schemaVersion: 1,
      workId: fixtureWorkId,
      createdAt: stamp,
      updatedAt: stamp,
      glossary: [
        {
          id: "existing",
          source: "猫",
          target: "기존 번역",
          category: "term",
          enabled: true,
          createdAt: stamp,
          updatedAt: stamp,
        },
      ],
      characters: [],
      rules: {
        prompt: "",
        honorifics: "adapt",
        sfxMode: "translate",
        defaultTone: "natural_korean",
      },
    };
    await put(target, `${fixtureWork}/style-guide.json`, existing);
    const orphan = `${fixtureWork}/chapters/extra/pages/1.png`;
    await put(source, orphan, "");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(source, orphan), png);
    const badMask = `${fixtureChapter}/pages/mask.png`;
    await writeLegacyLibraryBackup(source, archive, 1, 1, badMask);
    const archiveBytes = await readFile(archive);
    const originalChapter = await readFile(join(target, chapterPath));
    const settings = await readFile(join(target, "settings.json"));
    const store = new EnvironmentBackupStore(paths(target), "3.9.0");
    const getPaths = vi
      .spyOn(appPaths, "getAppPaths")
      .mockReturnValue(paths(target));
    try {
      const preview = await store.previewWithRecovery(
        archive,
        signal(),
        progress,
      );
      expect(preview.partial?.items).toHaveLength(2);
      const terms = preview.partial?.items.find((item) => item.terms === 2);
      const work = preview.partial?.items.find((item) => item.pages === 2);
      if (!terms || !work)
        throw new Error("Expected recoverable glossary and pages");
      expect(work.chapters).toBe(2);
      expect(preview.partial?.targets).toEqual([
        { id: fixtureWorkId, title: "이관 테스트" },
      ]);
      expect(preview.partial?.issues.join(" ")).toContain("mask.png");
      await expect(store.schedule(preview.id, {})).rejects.toThrow();
      await expect(
        store.recoverItems(
          preview,
          [{ sourceId: work.sourceId, workId: fixtureWorkId }],
          signal(),
          () => {},
        ),
      ).rejects.toThrow("target");
      const targets = [{ sourceId: terms.sourceId, workId: fixtureWorkId }];
      await expect(
        store.recoverItems(preview, targets, signal(), () => {
          throw new Error("cancel");
        }),
      ).rejects.toThrow("cancel");
      expect((await listLibrary()).workOrder).toEqual([fixtureWorkId]);
      expect((await readWorkStyleGuide(fixtureWorkId)).glossary).toHaveLength(
        1,
      );
      await store.recoverItems(preview, targets, signal(), () => {});
      expect((await listLibrary()).workOrder).toEqual([
        fixtureWorkId,
        work.sourceId,
      ]);
      const added = (await listLibrary()).works.find(
        (item) => item.id === work.sourceId,
      );
      if (!added) throw new Error("Expected new work");
      const chapters = await Promise.all(
        added.chapterOrder.map(
          async (id) =>
            JSON.parse(
              await readFile(
                join(
                  target,
                  "library",
                  "works",
                  work.sourceId,
                  "chapters",
                  id,
                  "chapter.json",
                ),
                "utf8",
              ),
            ) as LibraryChapter,
        ),
      );
      const recovered = chapters.flatMap((chapter) => chapter.pages);
      const edited = recovered.find((page) => page.blocks.length);
      const loose = recovered.find((page) => !page.blocks.length);
      if (!edited || !loose)
        throw new Error("Expected edited and original-only pages");
      expect(await readFile(edited.imagePath, "utf8")).toBe("original bytes");
      expect(edited.inpaintMaskPath).toBeUndefined();
      expect(await readFile(loose.imagePath)).toEqual(png);
      expect(
        (await readWorkStyleGuide(fixtureWorkId)).glossary.map(
          (entry) => entry.target,
        ),
      ).toEqual(["기존 번역", "마왕"]);
      expect(await readFile(join(target, chapterPath))).toEqual(
        originalChapter,
      );
      expect(await readFile(join(target, "settings.json"))).toEqual(settings);
      expect(await readFile(archive)).toEqual(archiveBytes);
      await expect(
        store.recoverItems(preview, targets, signal(), () => {}),
      ).rejects.toThrow("changed");
    } finally {
      getPaths.mockRestore();
    }
  });
  it.each([false, true])(
    "restores verified legacy records omitted from the index (work indexed = %s)",
    async (workIndexed) => {
      const source = await temp(),
        target = await temp(),
        out = await temp();
      await fixture(source);
      const workOrder = workIndexed ? [fixtureWorkId] : [];
      const stamp = "2026-09-24T00:00:00.000Z";
      const glossary = [
        {
          id: "term-1",
          source: "魔王",
          target: "마왕",
          category: "term",
          enabled: true,
          createdAt: stamp,
          updatedAt: stamp,
        },
      ];
      await put(source, `${fixtureWork}/style-guide.json`, {
        schemaVersion: 1,
        workId: fixtureWorkId,
        glossary,
        characters: [],
        rules: {
          prompt: "",
          honorifics: "adapt",
          sfxMode: "translate",
          defaultTone: "natural_korean",
        },
        createdAt: stamp,
        updatedAt: stamp,
      });
      await put(source, "library/index.json", { workOrder });
      const workPath = `${fixtureWork}/work.json`;
      const work = JSON.parse(await readFile(join(source, workPath), "utf8"));
      await put(source, workPath, { ...work, chapterOrder: [] });
      const archive = join(out, "legacy.zip");
      await writeLegacyLibraryBackup(source, archive, workOrder.length, 0);
      const original = await readFile(archive);
      const store = new EnvironmentBackupStore(paths(target), "3.8.15");
      const preview = await store.previewWithRecovery(
        archive,
        signal(),
        progress,
      );
      expect(preview.partial).toBeUndefined();
      expect(preview).toMatchObject({ works: 1, pages: 1 });
      expect(existsSync(join(target, "library/index.json"))).toBe(false);
      await store.schedule(preview.id, {});
      recoverEnvironmentRestore(target);
      const getPaths = vi
        .spyOn(appPaths, "getAppPaths")
        .mockReturnValue(paths(target));
      try {
        expect((await readWorkStyleGuide(fixtureWorkId)).glossary).toEqual(
          glossary,
        );
        expect(await listLibrary()).toMatchObject({
          workOrder: [fixtureWorkId],
          works: [
            {
              chapterOrder: [fixtureChapterId],
              chapters: [{ id: fixtureChapterId, pageCount: 1 }],
            },
          ],
        });
      } finally {
        getPaths.mockRestore();
      }
      const restored = JSON.parse(
        await readFile(join(target, chapterPath), "utf8"),
      ) as LibraryChapter;
      expect(restored.pages[0].imagePath).toBe(
        join(target, `${fixtureChapter}/pages/source.png`),
      );
      expect(await readFile(restored.pages[0].imagePath, "utf8")).toBe(
        "original bytes",
      );
      expect(await readFile(archive)).toEqual(original);
    },
  );

  it("repairs order in the exported copy while preserving the original library and its order", async () => {
    const source = await temp(),
      out = await temp(),
      extracted = await temp();
    await fixture(source);
    const work = JSON.parse(
      await readFile(join(source, `${fixtureWork}/work.json`), "utf8"),
    );
    await put(source, "library/works/work-z/work.json", {
      ...work,
      id: "work-z",
      chapterOrder: [],
    });
    await put(source, "library/index.json", { workOrder: ["work-z"] });
    const archive = join(out, "exported.zip");
    await new EnvironmentBackupStore(paths(source), "3.8.15").export(
      archive,
      {},
      signal(),
      progress,
    );
    const manifest = await extractBackupArchive({
      archive,
      root: extracted,
      signal: signal(),
      progress,
    });
    expect(manifest.summary).toMatchObject({ works: 2, pages: 1 });
    expect(
      JSON.parse(await readFile(join(extracted, "library/index.json"), "utf8"))
        .workOrder,
    ).toEqual(["work-z", fixtureWorkId]);
    expect(
      JSON.parse(await readFile(join(source, "library/index.json"), "utf8"))
        .workOrder,
    ).toEqual(["work-z"]);
  });

  it("rejects a false legacy summary or incomplete work before changing the destination", async () => {
    const source = await temp(),
      target = await temp(),
      out = await temp();
    await fixture(source);
    await put(source, "library/index.json", { workOrder: [] });
    await put(target, "library/keep.txt", "keep");
    const store = new EnvironmentBackupStore(paths(target), "3.8.15");
    const archive = join(out, "invalid.zip");
    await writeLegacyLibraryBackup(source, archive, 1, 1);
    await expect(store.preview(archive, signal(), progress)).rejects.toThrow(
      /counts/,
    );
    await unlink(join(source, `${fixtureWork}/work.json`));
    await writeLegacyLibraryBackup(source, archive, 0, 0);
    await expect(store.preview(archive, signal(), progress)).rejects.toThrow(
      /work.json/,
    );
    expect(await readFile(join(target, "library/keep.txt"), "utf8")).toBe(
      "keep",
    );
    expect(existsSync(join(backupWorkspace(target), "journal.json"))).toBe(
      false,
    );
  });

  it("keeps valid translated blocks from a malformed page and uses the surviving cleaned image", async () => {
    const source = await temp(),
      target = await temp(),
      archive = join(await temp(), "page.zip");
    await fixture(source);
    const chapter = JSON.parse(
      await readFile(join(source, chapterPath), "utf8"),
    ) as LibraryChapter;
    const record = chapter.pages[0];
    await put(source, chapterPath, {
      ...chapter,
      pages: [
        {
          ...record,
          blocks: [...record.blocks, { id: "invalid" }],
          obsoleteField: true,
        },
        null,
      ],
    });
    await unlink(record.imagePath);
    await writeLegacyLibraryBackup(source, archive, 1, 1);
    const store = new EnvironmentBackupStore(paths(target), "3.9.0");
    const preview = await store.previewWithRecovery(
      archive,
      signal(),
      progress,
    );
    const item = preview.partial?.items[0];
    if (!item) throw new Error("Expected repaired work");
    const pathsOverride = vi
      .spyOn(appPaths, "getAppPaths")
      .mockReturnValue(paths(target));
    try {
      expect(preview.partial?.issues).toContain(
        chapterPath.replace("library/works/", ""),
      );
      await store.recoverItems(preview, [], signal(), () => {});
      const work = (await listLibrary()).works[0];
      const repaired = JSON.parse(
        await readFile(
          join(
            target,
            "library/works",
            work.id,
            "chapters",
            work.chapterOrder[0],
            "chapter.json",
          ),
          "utf8",
        ),
      ) as LibraryChapter;
      expect(repaired.pages).toHaveLength(1);
      expect(repaired.pages[0].blocks).toHaveLength(record.blocks.length);
      expect(repaired.pages[0].blocks[0].translatedText).toBe(
        record.blocks[0].translatedText,
      );
      expect(await readFile(repaired.pages[0].imagePath, "utf8")).toBe(
        "inpainted bytes",
      );
    } finally {
      pathsOverride.mockRestore();
    }
  });

  it("recovers glossary-only backups as a new work and rejects a changed partial preview", async () => {
    const source = await temp(),
      target = await temp(),
      archive = join(await temp(), "terms.zip");
    const termFile = "library/works/guide/style-guide.json";
    await put(source, termFile, {
      glossary: [{ source: "星", target: "별" }],
      characters: [{ displayName: "소라" }],
    });
    await writeLegacyLibraryBackup(source, archive, 0, 0);
    const store = new EnvironmentBackupStore(paths(target), "3.9.0");
    const stale = await store.previewWithRecovery(archive, signal(), progress);
    const first = stale.partial?.items[0];
    if (!first) throw new Error("Expected glossary");
    const staged = join(
      stagePath(target, stale.id),
      first.sourceId,
      "style-guide.json",
    );
    await writeFile(staged, "{}");
    await expect(
      store.recoverItems(stale, [], signal(), () => {}),
    ).rejects.toThrow("changed");
    await store.discard(stale.id);
    expect(existsSync(join(target, "library", "index.json"))).toBe(false);
    const next = await store.previewWithRecovery(archive, signal(), progress);
    const recovered = next.partial?.items[0];
    if (!recovered) throw new Error("Expected glossary");
    expect(next.partial?.targets).toEqual([]);
    expect(recovered).toMatchObject({
      chapters: 0,
      pages: 0,
      terms: 2,
      sample: ["星 → 별", "소라"],
    });
    const pathsOverride = vi
      .spyOn(appPaths, "getAppPaths")
      .mockReturnValue(paths(target));
    try {
      await store.recoverItems(next, [], signal(), () => {});
      expect((await listLibrary()).workOrder).toEqual([recovered.sourceId]);
      expect(
        (await readWorkStyleGuide(recovered.sourceId)).characters[0]
          .displayName,
      ).toBe("소라");
    } finally {
      pathsOverride.mockRestore();
    }
  });
  it("round trips an environment across roots without credentials, then restores the original destination", async () => {
    const source = await temp(),
      target = await temp(),
      out = await temp();
    await fixture(source);
    await put(target, "library/original.txt", "DESTINATION WORK");
    await put(target, "codex/auth.json", "DESTINATION LOGIN");
    await commitSettingsPair(
      paths(target),
      { ...resolveDefaultAppSettings({}, null) },
      {
        apiProfiles: { custom: { apiKey: "DESTINATION_API_KEY" } },
      },
    );
    const archive = join(out, "backup.zip");
    const exportProgress = vi.fn();
    await new EnvironmentBackupStore(paths(source), "2.8.0").export(
      archive,
      { "library-sort": "title:asc" },
      signal(),
      exportProgress,
    );
    expect([
      ...new Set(exportProgress.mock.calls.map((call) => call[2])),
    ]).toEqual(["backup-copying", "backup-verifying", "backup-compressing"]);
    for (const phase of [
      "backup-copying",
      "backup-verifying",
      "backup-compressing",
    ]) {
      const calls = exportProgress.mock.calls.filter(
        (call) => call[2] === phase,
      );
      expect(calls[0][0]).toBe(0);
      const last = calls[calls.length - 1];
      expect(last[0]).toBe(last[1]);
      expect(last[1]).toBeGreaterThan(0);
    }
    const inspectRoot = await temp();
    const manifest = await extractBackupArchive({
      archive,
      root: inspectRoot,
      signal: signal(),
      progress,
    });
    expect(manifest.summary).toMatchObject({ works: 1, pages: 1 });
    expect(
      manifest.files.some((file) =>
        /auth|secrets|hf-cache|settings-pairs/.test(file.path),
      ),
    ).toBe(false);
    expect(
      await readFile(join(inspectRoot, "portable-settings.json"), "utf8"),
    ).not.toContain("SOURCE_API_KEY");
    const portable = JSON.parse(
      await readFile(join(inspectRoot, chapterPath), "utf8"),
    ) as LibraryChapter;
    expect(portable.pages[0].imagePath).toBe(
      `${fixtureChapter}/pages/source.png`,
    );
    const store = new EnvironmentBackupStore(paths(target), "2.8.0");
    const inspectProgress = vi.fn();
    const preview = await store.preview(archive, signal(), inspectProgress);
    const stages = inspectProgress.mock.calls;
    const finalizing = stages.findIndex(
      (call) => call[2] === "import-finalizing",
    );
    expect(stages[finalizing - 1]).toEqual([
      manifest.summary.bytes,
      manifest.summary.bytes,
      "backup-verifying",
    ]);
    expect(stages[finalizing]).toEqual([0, 0, "import-finalizing"]);
    const files = stages[stages.length - 1][1];
    expect(files).toBeGreaterThan(1);
    expect(stages.slice(finalizing + 1)).toEqual(
      Array.from({ length: files }, (_, i) => [
        i + 1,
        files,
        "import-finalizing",
      ]),
    );
    expect(preview.connections).toEqual(["D:\\external-originals"]);
    expect(await readFile(join(target, "library/original.txt"), "utf8")).toBe(
      "DESTINATION WORK",
    );
    await store.schedule(preview.id, { "editor.richText.mode": "code" });
    recoverEnvironmentRestore(target);
    const restored = JSON.parse(
      await readFile(join(target, chapterPath), "utf8"),
    ) as LibraryChapter;
    expect(restored.pages[0].imagePath).toBe(
      join(target, portable.pages[0].imagePath),
    );
    expect(restored.pages[0].translationCheckpoint?.inputRevision).toBe(
      createPageRevision(restored.pages[0]),
    );
    const cp = await readFile(
      join(
        target,
        `${fixtureChapter}/.translation-checkpoint-test/checkpoint.json`,
      ),
    );
    expect(createHash("sha256").update(cp).digest("hex")).toBe(
      restored.pages[0].translationCheckpoint?.sha256,
    );
    expect(JSON.parse(cp.toString()).inputRevision).toBe(
      restored.pages[0].translationCheckpoint?.inputRevision,
    );
    expect(await readFile(restored.pages[0].imagePath, "utf8")).toBe(
      "original bytes",
    );
    expect(restored.pages[0].blocks).toEqual([clipboardBlock()]);
    expect(restored.pageOrder).toEqual([fixturePageId]);
    expect(
      await readFile(restored.pages[0].inpaintedImagePath ?? "", "utf8"),
    ).toBe("inpainted bytes");
    expect(
      await readFile(restored.pages[0].inpaintMaskPath ?? "", "utf8"),
    ).toBe("mask bytes");
    const drafts = await readRedactionSnapshot(target);
    expect(drafts.state.pages[restored.pages[0].imagePath]).toEqual({
      fingerprint: "a".repeat(64),
      width: 100,
      height: 100,
      strokes: [],
      decision: "reviewed",
    });
    expect(await readFile(join(target, "fonts/custom.ttf"), "utf8")).toBe(
      "font bytes",
    );
    expect(
      await readFile(
        join(
          target,
          "page-workflows/11111111-1111-4111-8111-111111111111.json",
        ),
        "utf8",
      ),
    ).toBe(
      await readFile(
        join(
          source,
          "page-workflows/11111111-1111-4111-8111-111111111111.json",
        ),
        "utf8",
      ),
    );
    expect(await loadSettingsSecrets(paths(target))).toEqual({});
    const restoredSettings = JSON.parse(
      await readFile(paths(target).settingsPath, "utf8"),
    );
    expect(restoredSettings.api.customProfiles.portable).toMatchObject({
      name: "Portable session",
      sessionHeaderEnabled: true,
      sessionHeaderName: "x-session",
      extraBodyJson: "{}",
    });
    expect(JSON.stringify(restoredSettings)).not.toMatch(
      /SOURCE_PROFILE_KEY|BODY_SECRET/,
    );
    expect(existsSync(join(target, "codex/auth.json"))).toBe(false);
    expect(existsSync(join(target, "linked-workspaces.json"))).toBe(false);
    expect(
      await readFile(
        join(preview.recoveryPath, "library/original.txt"),
        "utf8",
      ),
    ).toBe("DESTINATION WORK");
    const recoverId = await store.prepareRecovery(preview.id, signal());
    await store.schedule(recoverId, {});
    recoverEnvironmentRestore(target);
    expect(await readFile(join(target, "library/original.txt"), "utf8")).toBe(
      "DESTINATION WORK",
    );
    expect(await readFile(join(target, "codex/auth.json"), "utf8")).toBe(
      "DESTINATION LOGIN",
    );
    expect(existsSync(join(recoveryPath(target, recoverId), chapterPath))).toBe(
      true,
    );
  });

  it("rejects changed staging content before switching any destination data", async () => {
    const source = await temp(),
      target = await temp(),
      out = await temp();
    await fixture(source);
    const archive = join(out, "backup.zip");
    await new EnvironmentBackupStore(paths(source), "2.8.0").export(
      archive,
      {},
      signal(),
      progress,
    );
    const store = new EnvironmentBackupStore(paths(target), "2.8.0");
    const preview = await store.preview(archive, signal(), progress);
    await put(stagePath(target, preview.id), "settings.json", "tampered");
    await expect(store.schedule(preview.id, {})).rejects.toThrow("changed");
    expect(existsSync(join(backupWorkspace(target), "journal.json"))).toBe(
      false,
    );
  });

  it("recovers a page with an unusable ID without replacing the destination library", async () => {
    const source = await temp(),
      target = await temp(),
      out = await temp();
    await fixture(source);
    const chapter = JSON.parse(
      await readFile(join(source, chapterPath), "utf8"),
    );
    chapter.pages[0].id = "legacy-page";
    chapter.pageOrder = ["legacy-page"];
    await put(source, chapterPath, chapter);
    await put(target, "library/keep.txt", "keep");
    const archive = join(out, "invalid-id.zip");
    await writeLegacyLibraryBackup(source, archive, 1, 1);
    const store = new EnvironmentBackupStore(paths(target), "3.9.0");
    const preview = await store.previewWithRecovery(
      archive,
      signal(),
      progress,
    );
    expect(preview.partial?.items[0]).toMatchObject({ chapters: 1, pages: 1 });
    expect(preview.partial?.issues).toContain(
      chapterPath.replace("library/works/", ""),
    );
    const root = vi
      .spyOn(appPaths, "getAppPaths")
      .mockReturnValue(paths(target));
    try {
      await store.recoverItems(preview, [], signal(), () => {});
      const work = (await listLibrary()).works[0];
      const repaired = JSON.parse(
        await readFile(
          join(
            target,
            "library/works",
            work.id,
            "chapters",
            work.chapterOrder[0],
            "chapter.json",
          ),
          "utf8",
        ),
      );
      expect(repaired.pageOrder).toEqual([repaired.pages[0].id]);
      expect(repaired.pages[0].id).toMatch(/^[a-f0-9-]{36}$/);
      expect(await readFile(join(target, "library/keep.txt"), "utf8")).toBe(
        "keep",
      );
    } finally {
      root.mockRestore();
    }
  });

  it.each([
    "../escape",
    "library/AUX.txt",
    "library/a.",
    "library/a:b",
    "library/../x",
    "C:/escape",
    "library\\x",
  ])("rejects non-portable archive path %s", (path) => {
    expect(() => backupRelativePath(path)).toThrow();
  });

  it("rejects junctions without changing the referenced originals", async () => {
    const root = await temp(),
      outside = await temp();
    await put(outside, "original.txt", "KEEP");
    const link = join(root, "linked");
    await symlink(outside, link, "junction");
    try {
      await expect(regularFiles(root)).rejects.toThrow("Linked");
    } finally {
      await unlink(link);
    }
    expect(await readFile(join(outside, "original.txt"), "utf8")).toBe("KEEP");
  });

  it("copies selected categories without a progress observer and preserves nested bytes", async () => {
    const source = await temp();
    const target = await temp();
    await put(source, "fonts/nested/a.ttf", "first font bytes");
    await put(source, "fonts/b.ttf", "second font bytes");

    await copyCategories(source, target, ["fonts", "missing"], signal());

    expect(await regularFiles(target)).toEqual([
      "fonts/b.ttf",
      "fonts/nested/a.ttf",
    ]);
    for (const path of await regularFiles(source)) {
      expect(await readFile(join(target, path))).toEqual(
        await readFile(join(source, path)),
      );
    }
  });

  it.each(["before-enumeration", "before-copy"] as const)(
    "honors cancellation %s without publishing any copied file",
    async (point) => {
      const source = await temp();
      const target = await temp();
      await put(source, "fonts/original.ttf", "preserved source bytes");
      const controller = new AbortController();
      const reason = new Error(`cancel ${point}`);
      if (point === "before-enumeration") controller.abort(reason);
      const report = vi.fn((current: number) => {
        expect(current).toBe(0);
        controller.abort(reason);
      });

      await expect(
        copyCategories(source, target, ["fonts"], controller.signal, report),
      ).rejects.toBe(reason);

      expect(report).toHaveBeenCalledTimes(point === "before-copy" ? 1 : 0);
      expect(await regularFiles(target)).toEqual([]);
      expect(await readFile(join(source, "fonts/original.ttf"), "utf8")).toBe(
        "preserved source bytes",
      );
    },
  );

  it("rejects a library junction before following its child paths", async () => {
    const root = await temp(),
      outside = await temp(),
      target = await temp();
    await put(outside, "index.json", { workOrder: [] });
    const link = join(root, "library");
    await symlink(outside, link, "junction");
    try {
      await expect(
        copyCategories(root, target, BACKUP_SOURCE_NAMES, signal()),
      ).rejects.toThrow("Linked");
    } finally {
      await unlink(link);
    }
    expect(await readFile(join(outside, "index.json"), "utf8")).toBe(
      '{"workOrder":[]}',
    );
  });

  it("round trips an empty library and discards an unused preview", async () => {
    const source = await temp(),
      target = await temp(),
      output = await temp();
    const archive = join(output, "empty.zip");
    await new EnvironmentBackupStore(paths(source), "2.8.0").export(
      archive,
      {},
      signal(),
      progress,
    );
    const store = new EnvironmentBackupStore(paths(target), "2.8.0");
    const preview = await store.preview(archive, signal(), progress);
    expect(preview).toMatchObject({ works: 0, pages: 0 });
    await store.discard(preview.id);
    expect(existsSync(stagePath(target, preview.id))).toBe(false);
    expect(existsSync(join(backupWorkspace(target), "journal.json"))).toBe(
      false,
    );
  });

  it("rebinds current workflow fingerprints while preserving stale receipts", () => {
    const before: LibraryPageRecord = {
      id: "p",
      name: "p",
      imagePath: "C:/old/p.png",
      width: 10,
      height: 10,
      blocks: [],
      analysisStatus: "idle",
      createdAt: "",
      updatedAt: "",
    };
    const key = workflowStageKey({ ...before, dataUrl: "" }, "detect");
    before.pageWorkflow = {
      runId: randomUUID(),
      planKey: "plan",
      emptyDetectionKey: key,
      findings: [],
      steps: {
        detect: {
          status: "empty",
          inputKey: key,
          outputKey: key,
          resumeKey: key,
        },
        translate: {
          status: "completed",
          inputKey: "stale",
          outputKey: "stale",
          resumeKey: "stale",
        },
      },
    };
    const after = { ...structuredClone(before), imagePath: "/new/p.png" };
    relocateBackupWorkflow(before, after);
    const next = workflowStageKey({ ...after, dataUrl: "" }, "detect");
    expect(next).not.toBe(key);
    expect(after.pageWorkflow?.steps.detect?.resumeKey).toBe(next);
    expect(after.pageWorkflow?.emptyDetectionKey).toBe(next);
    expect(after.pageWorkflow?.steps.translate?.resumeKey).toBe("stale");
    expect(before.pageWorkflow.steps.detect?.resumeKey).toBe(key);
  });

  it.each(["C:\\old\\data", "/Users/old/data"])(
    "the existing copy relocation supports %s",
    (oldRoot) => {
      const result = relocateCopiedChapterImagePath({
        worksRoot: "/new/library/works",
        workId: "work-a",
        chapterId: "chapter-a",
        imagePath: `${oldRoot}/library/works/work-a/chapters/chapter-a/pages/p.png`,
      });
      expect(result).toBe(
        join(resolveNewWorks(), "work-a/chapters/chapter-a/pages/p.png"),
      );
    },
  );
});
function resolveNewWorks() {
  return join(
    process.platform === "win32" ? process.cwd().slice(0, 2) + "\\" : "/",
    "new/library/works",
  );
}

describe("restore journal", () => {
  it.each(RESTORE_NAMES)(
    "recovers the original environment after an error at %s",
    async (failureName) => {
      const root = await temp(),
        id = randomUUID();
      createBackupStage(root, id);
      for (const name of RESTORE_NAMES) {
        await put(root, name, `old:${name}`);
        await put(stagePath(root, id), name, `new:${name}`);
      }
      scheduleEnvironmentRestore(root, id);
      expect(() =>
        recoverEnvironmentRestore(root, (name) => {
          if (name === failureName) throw new Error("simulated lock failure");
        }),
      ).toThrow("previous environment");
      for (const name of RESTORE_NAMES)
        expect(await readFile(join(root, name), "utf8")).toBe(`old:${name}`);
    },
  );
  it.each(["original-moved", "replacement-installed"])(
    "continues after process interruption at %s",
    async (point) => {
      const root = await temp(),
        id = randomUUID();
      createBackupStage(root, id);
      await put(root, "settings.json", "old");
      await put(stagePath(root, id), "settings.json", "new");
      scheduleEnvironmentRestore(root, id);
      renameSync(
        join(root, "settings.json"),
        join(recoveryPath(root, id), "settings.json"),
      );
      if (point === "replacement-installed")
        renameSync(
          join(stagePath(root, id), "settings.json"),
          join(root, "settings.json"),
        );
      recoverEnvironmentRestore(root);
      expect(await readFile(join(root, "settings.json"), "utf8")).toBe("new");
      expect(
        await readFile(join(recoveryPath(root, id), "settings.json"), "utf8"),
      ).toBe("old");
    },
  );
  it("restarts an interrupted rollback without mistaking recovered originals for replacements", async () => {
    const root = await temp(),
      id = randomUUID();
    createBackupStage(root, id);
    await put(root, "settings.json", "old");
    await put(stagePath(root, id), "settings.json", "new");
    scheduleEnvironmentRestore(root, id);
    const path = join(backupWorkspace(root), "journal.json");
    const journal = JSON.parse(readFileSync(path, "utf8"));
    journal.phase = "rollback";
    writeFileSync(path, JSON.stringify(journal));
    recoverEnvironmentRestore(root);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe("old");
  });
});
