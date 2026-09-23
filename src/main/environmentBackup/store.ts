import { validateBackupUserStores } from "./validate";
import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AppPaths } from "../appPaths";
import {
  backupStatusSchema,
  type BackupPreview,
  type BackupStatus,
  type BackupUiPreferences,
} from "../../shared/environmentBackup";
import { writeJsonFile } from "../libraryStore/storage";
import { RESTORE_NAMES } from "./policy";
import {
  copyCategories,
  captureEnvironment,
  linkedConnectionHints,
} from "./snapshot";
import { exists, readBackupJson, regularFiles, hashBackupFile } from "./files";
import { extractBackupArchive, writeBackupArchive } from "./archive";
import { relocateBackupLibrary } from "./library";
import { relocateBackupRedaction } from "./redaction";
import { importPortableSettings } from "./settings";
import {
  backupWorkspace,
  createBackupStage,
  stagePath,
  recoveryPath,
  scheduleEnvironmentRestore,
} from "./transaction";

type Progress = (current: number, total: number) => void;
export class EnvironmentBackupStore {
  constructor(
    private readonly paths: AppPaths,
    private readonly appVersion: string,
  ) {}
  async discard(id: string): Promise<void> {
    if (
      await exists(join(backupWorkspace(this.paths.dataRoot), "journal.json"))
    )
      throw new Error("A restore is awaiting restart.");
    await this.removeStage(stagePath(this.paths.dataRoot, id));
  }
  async receipt(): Promise<BackupStatus["restored"]> {
    const path = join(this.paths.dataRoot, "migration-ui.json");
    return backupStatusSchema.shape.restored.parse(
      (await exists(path)) ? await readBackupJson(path) : null,
    );
  }
  async status(): Promise<BackupStatus> {
    const root = this.paths.dataRoot;
    const recoveries: BackupStatus["recoveries"] = [];
    const directory = join(backupWorkspace(root), "recovery");
    if (await exists(directory))
      for (const id of await readdir(directory)) {
        const path = recoveryPath(root, id);
        if (await exists(join(path, "recovery.json")))
          recoveries.push({
            ...((await readBackupJson(join(path, "recovery.json"))) as {
              id: string;
              createdAt: string;
            }),
            path,
          });
      }
    const receipt = join(root, "migration-ui.json");
    return backupStatusSchema.parse({
      summary: await this.summary(),
      recoveries: recoveries.sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
      restored: (await exists(receipt)) ? await readBackupJson(receipt) : null,
    });
  }
  private async summary(): Promise<BackupStatus["summary"]> {
    const root = this.paths.libraryDir;
    if (!(await exists(root))) return { works: 0, pages: 0, bytes: 0 };
    const files = await regularFiles(root);
    let works = 0,
      pages = 0;
    for (const path of files) {
      if (path.endsWith("/work.json")) works++;
      if (path.endsWith("/chapter.json"))
        pages += (
          (await readBackupJson(join(root, path))) as { pages: unknown[] }
        ).pages.length;
    }
    return { works, pages, bytes: 0 };
  }
  async export(
    target: string,
    ui: BackupUiPreferences,
    signal: AbortSignal,
    progress: Progress,
  ): Promise<void> {
    if (
      resolve(target).startsWith(
        `${resolve(this.paths.dataRoot)}${process.platform === "win32" ? "\\" : "/"}`,
      )
    )
      throw new Error("Choose a backup destination outside the data folder.");
    const root = createBackupStage(this.paths.dataRoot, randomUUID());
    try {
      const snapshot = await captureEnvironment(root, {
        paths: this.paths,
        appVersion: this.appVersion,
        ui,
        signal,
        progress,
      });
      await writeBackupArchive(root, target, snapshot.manifest, signal);
    } finally {
      await this.removeStage(root);
    }
  }
  async preview(
    archive: string,
    signal: AbortSignal,
    progress: Progress,
  ): Promise<BackupPreview> {
    const id = randomUUID(),
      root = createBackupStage(this.paths.dataRoot, id);
    try {
      const manifest = await extractBackupArchive({
        archive,
        root,
        signal,
        progress,
      });
      await validateBackupUserStores(root);
      const summary = await relocateBackupLibrary(
        root,
        manifest.files.map((entry) => entry.path),
        this.paths.dataRoot,
      );
      if (
        summary.works !== manifest.summary.works ||
        summary.pages !== manifest.summary.pages
      )
        throw new Error("Backup counts do not match its library.");
      await relocateBackupRedaction(root, this.paths.dataRoot);
      await importPortableSettings(
        await readBackupJson(join(root, "portable-settings.json")),
        {
          ...this.paths,
          dataRoot: root,
          settingsPath: join(root, "settings.json"),
        },
      );
      await writeJsonFile(join(root, "migration-ui.json"), {
        id,
        ui: manifest.ui,
        connections: manifest.connections,
      });
      await this.sealStage(root, signal);
      return {
        id,
        ...manifest.summary,
        createdAt: manifest.createdAt,
        appVersion: manifest.appVersion,
        recoveryPath: recoveryPath(this.paths.dataRoot, id),
        connections: manifest.connections,
      };
    } catch (error) {
      await this.removeStage(root);
      throw error;
    }
  }
  async prepareRecovery(id: string, signal: AbortSignal): Promise<string> {
    const source = recoveryPath(this.paths.dataRoot, id);
    if (!(await exists(join(source, "recovery.json"))))
      throw new Error("Recovery environment is missing.");
    const nextId = randomUUID(),
      root = createBackupStage(this.paths.dataRoot, nextId);
    try {
      await copyCategories(
        source,
        root,
        RESTORE_NAMES.filter(
          (name) =>
            name !== "linked-workspaces.json" &&
            name !== "linked-sync-queue.json",
        ),
        signal,
      );
      const receipt = join(root, "migration-ui.json");
      const old = (await exists(receipt))
        ? ((await readBackupJson(receipt)) as {
            ui: BackupUiPreferences;
            connections: string[];
          })
        : { ui: {}, connections: [] };
      const recovery = (await readBackupJson(
        join(source, "recovery.json"),
      )) as { ui?: BackupUiPreferences };
      await writeJsonFile(receipt, {
        ...old,
        connections: await linkedConnectionHints(source),
        ui: recovery.ui ?? old.ui,
        id: nextId,
      });
      await this.sealStage(root, signal);
      return nextId;
    } catch (error) {
      await this.removeStage(root);
      throw error;
    }
  }
  async schedule(id: string, ui: BackupUiPreferences): Promise<void> {
    const root = stagePath(this.paths.dataRoot, id),
      signal = new AbortController().signal;
    const expected = await readBackupJson(join(root, "stage-seal.json"));
    const actual = await this.stageInventory(root, signal);
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      throw new Error("Prepared backup changed. Please select it again.");
    for (const name of RESTORE_NAMES)
      if (await exists(join(this.paths.dataRoot, name)))
        await regularFiles(join(this.paths.dataRoot, name), name);
    scheduleEnvironmentRestore(this.paths.dataRoot, id, ui);
  }
  private async stageInventory(root: string, signal: AbortSignal) {
    const result = [];
    for (const path of await regularFiles(root))
      if (path !== "stage-seal.json")
        result.push(await hashBackupFile(root, path, signal));
    return result;
  }
  private async sealStage(root: string, signal: AbortSignal): Promise<void> {
    await writeJsonFile(
      join(root, "stage-seal.json"),
      await this.stageInventory(root, signal),
    );
  }
  private async removeStage(root: string): Promise<void> {
    // Only our UUID staging directory; reject links before recursive deletion.
    const id = root.split(/[\\/]/).pop() ?? "";
    if (resolve(stagePath(this.paths.dataRoot, id)) !== resolve(root))
      throw new Error("Invalid staging cleanup path.");
    await regularFiles(root);
    await rm(root, { recursive: true });
  }
}
