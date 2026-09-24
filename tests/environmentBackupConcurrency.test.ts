import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { IpcContext } from "../src/main/ipc/context";
import type { AppPaths } from "../src/main/appPaths";
import { createEnvironmentBackupService } from "../src/main/environmentBackup/runtime";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";
import { libraryMutationCoordinator as coordinator } from "../src/main/libraryStore/libraryMutationCoordinator";
import * as access from "../src/main/environmentBackup/access";
import * as lock from "../src/main/library/lock";
import { withMcpContextEditScope } from "../src/main/mcp/mcpContextEditScope";
import { extractBackupArchive } from "../src/main/environmentBackup/archive";

const native = vi.hoisted(() => ({ archive: "" }));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "2.8.2" },
  dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: native.archive }),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const output = await mkdtemp(join(tmpdir(), "carrot-backup-concurrency-"));
  const root = join(output, "data");
  await mkdir(root);
  const env = { root, libraryDir: join(root, "library") };
  const archive = join(output, "environment.zip");
  native.archive = archive;
  const appPaths: AppPaths = {
    dataRoot: root,
    libraryDir: env.libraryDir,
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
  const jobs = new ActiveJobStore({ error: vi.fn(), info: vi.fn() });
  const operations = new AppOperationRegistry(jobs.gate);
  coordinator.configureActivityGate(jobs.gate);
  const service = createEnvironmentBackupService({
    appPaths,
    jobs,
    operations,
  } as IpcContext);
  return {
    env,
    output,
    archive,
    jobs,
    operations,
    coordinator,
    access,
    lock,
    withMcpContextEditScope,
    extractBackupArchive,
    service,
    async close() {
      coordinator.configureActivityGate(null);
      await rm(output, { recursive: true, force: true });
    },
  };
}

it("drains an admitted IPC save and completes backup before a queued MCP context edit", async () => {
  const f = await fixture();
  const releaseIpc = deferred();
  const backupStarted = deferred();
  const lifetime = new AbortController();
  const order: string[] = [];
  const detach = f.operations.subscribeActivity((event) => {
    if (event.status === "running") backupStarted.resolve();
    if (event.status === "completed") order.push("backup-completed");
  });
  // The IPC arrived first, but its native save has not requested admission yet.
  const ipc = f.access.trackEnvironmentAccess(
    "library:save-page-blocks",
    async () => {
      await releaseIpc.promise;
      return f.lock.withLibraryMutation(async () => {
        await mkdir(f.env.libraryDir, { recursive: true });
        await writeFile(
          join(f.env.libraryDir, "index.json"),
          '{"workOrder":[]}',
        );
        order.push("ipc-saved");
      });
    },
  );
  const backup = f.service.export({});
  let edit: Promise<unknown> | undefined;
  try {
    await backupStarted.promise;
    await expect(
      f.access.trackEnvironmentAccess("settings:save", () => undefined),
    ).rejects.toThrow("backup");
    edit = f.withMcpContextEditScope(
      { chapterId: "chapter", workId: "work" },
      {
        chapterId: "chapter",
        revision: "context-v1:reviewed",
        requestId: randomUUID(),
        changes: [
          { changeId: "rule", entity: "rules", values: { sfxMode: "note" } },
        ],
      },
      lifetime.signal,
      () => {},
      () =>
        f.lock.withLibraryMutation(async () => {
          await writeFile(join(f.env.root, "context-result.txt"), "saved");
          order.push("mcp-saved");
        }),
    );
    // Waiting for backup ownership must not count as a mutation backup must drain.
    expect(f.coordinator.getActiveCountForTests()).toBe(0);
    expect(order).toEqual([]);
    releaseIpc.resolve();
    await expect(backup).resolves.toBe(f.archive);
    await ipc;
    await edit;
    expect(order).toEqual(["ipc-saved", "backup-completed", "mcp-saved"]);
    expect(f.jobs.gate.activities).toEqual([]);
    expect(f.coordinator.getActiveCountForTests()).toBe(0);
    const restored = join(f.output, "restored");
    await mkdir(restored);
    await f.extractBackupArchive({
      archive: f.archive,
      root: restored,
      signal: lifetime.signal,
      progress: () => {},
    });
    expect(
      await readFile(join(restored, "library", "index.json"), "utf8"),
    ).toBe('{"workOrder":[]}');
  } finally {
    lifetime.abort();
    releaseIpc.resolve();
    await Promise.allSettled([ipc, backup, ...(edit ? [edit] : [])]);
    detach();
    await f.close();
  }
});
