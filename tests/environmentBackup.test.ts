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
import { regularFiles } from "../src/main/environmentBackup/files";
import { extractBackupArchive } from "../src/main/environmentBackup/archive";
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
const chapterPath = "library/works/work-a/chapters/chapter-a/chapter.json";
async function fixture(root: string) {
  const stamp = "2026-09-24T00:00:00.000Z";
  await put(root, "library/index.json", { workOrder: ["work-a"] });
  await put(root, "library/works/work-a/work.json", {
    id: "work-a",
    title: "이관 테스트",
    chapterOrder: ["chapter-a"],
    createdAt: stamp,
    updatedAt: stamp,
  });
  const imagePath = join(
    root,
    "library/works/work-a/chapters/chapter-a/pages/source.png",
  );
  await put(
    root,
    "library/works/work-a/chapters/chapter-a/pages/source.png",
    "original bytes",
  );
  const page = {
    id: "page-a",
    name: "원본",
    imagePath,
    width: 100,
    height: 100,
    blocks: [clipboardBlock()],
    inpaintedImagePath: join(
      root,
      "library/works/work-a/chapters/chapter-a/pages/result.png",
    ),
    inpaintMaskPath: join(
      root,
      "library/works/work-a/chapters/chapter-a/pages/mask.png",
    ),
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
  await put(
    root,
    "library/works/work-a/chapters/chapter-a/pages/result.png",
    "inpainted bytes",
  );
  await put(
    root,
    "library/works/work-a/chapters/chapter-a/pages/mask.png",
    "mask bytes",
  );
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
    "library/works/work-a/chapters/chapter-a/.translation-checkpoint-test/checkpoint.json",
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
    id: "chapter-a",
    workId: "work-a",
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
  await commitSettingsPair(
    paths(root),
    { ...settings },
    { apiProfiles: { custom: { apiKey: "SOURCE_API_KEY" } } },
  );
  return { imagePath, checkpoint };
}

describe("environment backup", () => {
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
    await new EnvironmentBackupStore(paths(source), "2.8.0").export(
      archive,
      { "library-sort": "title:asc" },
      signal(),
      progress,
    );
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
      "library/works/work-a/chapters/chapter-a/pages/source.png",
    );
    const store = new EnvironmentBackupStore(paths(target), "2.8.0");
    const preview = await store.preview(archive, signal(), progress);
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
        "library/works/work-a/chapters/chapter-a/.translation-checkpoint-test/checkpoint.json",
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
    expect(restored.pageOrder).toEqual(["page-a"]);
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
