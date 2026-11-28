import { createHash, randomUUID } from "node:crypto";
import { tMain } from "../libraryStore/localization";
import { join } from "node:path";
import type { AppPaths } from "../appPaths";
import type {
  BackupPreview,
  BackupProgress,
  GlossaryTargets,
  RecoveredWork,
} from "../../shared/environmentBackup";
import {
  StoredLibraryIndexFileSchema,
  LibraryWorkFileSchema,
} from "../../shared/ipcLibrarySchemas";
import { WorkStyleGuideSchema } from "../../shared/ipcWorkContextSchemas";
import {
  applyWorkGlossaryImport,
  planWorkGlossaryImport,
} from "../../shared/workGlossaryImportPlan";
import { readWorkStyleGuide } from "../libraryStore/workContextFiles";
import { readIndexFile } from "../libraryStore/libraryFiles";
import { runLibraryTransaction } from "../libraryStore/libraryTransaction";
import {
  stageIndexFile,
  stageStyleGuideFile,
} from "../libraryStore/libraryTransactionFiles";
import {
  hashBackupFile,
  regularFiles,
  readBackupJson,
  exists,
  copyBackupFile,
} from "./files";
import { createBackupStage, stagePath } from "./transaction";
import { extractBackupArchive } from "./archive";
import { prepareRecoveredWorks } from "./salvageLibrary";

type PartialPreview = NonNullable<BackupPreview["partial"]>;
async function inventorySeal(
  root: string,
  signal: AbortSignal,
  progress?: BackupProgress,
) {
  const hash = createHash("sha256");
  const files = await regularFiles(root, "", signal);
  for (const [index, path] of files.entries()) {
    hash.update(JSON.stringify(await hashBackupFile(root, path, signal)));
    progress?.(index + 1, files.length, "import-finalizing");
  }
  return hash.digest("hex");
}

async function glossaryDestinations(root: string) {
  const indexPath = join(root, "index.json");
  if (!(await exists(indexPath))) return [];
  const index = StoredLibraryIndexFileSchema.parse(
    await readBackupJson(indexPath),
  );
  const targets = [];
  for (const id of index.workOrder) {
    const path = join(root, "works", id, "work.json");
    if (!(await exists(path))) continue;
    const work = LibraryWorkFileSchema.safeParse(
      await readBackupJson(path),
    ).data;
    if (work?.id === id) targets.push({ id, title: work.title });
  }
  return targets;
}

export class PartialBackupRestore {
  private seals = new Map<string, string>();
  constructor(
    private paths: AppPaths,
    private removeStage: (root: string) => Promise<void>,
  ) {}
  forget(id: string) {
    this.seals.delete(id);
  }
  async preview(
    archive: string,
    signal: AbortSignal,
    progress: BackupProgress,
    originalError: unknown,
  ): Promise<BackupPreview> {
    const id = randomUUID(),
      stage = createBackupStage(this.paths.dataRoot, id);
    try {
      const source = createBackupStage(this.paths.dataRoot, randomUUID());
      const issues: string[] = [];
      const damaged = new Set<string>();
      const report = (path: string) => {
        if (damaged.has(path)) return;
        damaged.add(path);
        if (issues.length < 20)
          issues.push(path.replace(/^library\/works\//, "").slice(0, 300));
      };
      try {
        const manifest = await extractBackupArchive({
          archive,
          root: source,
          signal,
          progress,
          onDamagedFile: report,
        });
        progress(0, 0, "import-finalizing");
        const files = new Set(manifest.files.map((file) => file.path));
        const items = await prepareRecoveredWorks(
          { root: source, files, signal, report },
          stage,
          this.paths.libraryDir,
        );
        if (!items.length) throw originalError;
        const targets = items.some((item) => !item.chapters && item.terms)
          ? await glossaryDestinations(this.paths.libraryDir)
          : [];
        this.seals.set(id, await inventorySeal(stage, signal, progress));
        return {
          id,
          appVersion: manifest.appVersion,
          createdAt: manifest.createdAt,
          bytes: manifest.summary.bytes,
          works: items.length,
          pages: items.reduce((total, item) => total + item.pages, 0),
          connections: [],
          recoveryPath: "",
          partial: { items, targets, issues, issueCount: damaged.size },
        };
      } finally {
        await this.removeStage(source);
      }
    } catch (error) {
      this.forget(id);
      await this.removeStage(stage);
      throw error;
    }
  }
  async apply(
    preview: BackupPreview,
    choices: GlossaryTargets,
    signal: AbortSignal,
    seal: () => void,
  ) {
    const { partial, id } = preview;
    const stage = stagePath(this.paths.dataRoot, id);
    if (
      !partial ||
      !this.seals.has(id) ||
      this.seals.get(id) !== (await inventorySeal(stage, signal))
    )
      throw new Error("Prepared backup changed. Please select it again.");
    const destinations = selectDestinations(partial, choices);
    await runLibraryTransaction("environment-backup-partial", async (tx) => {
      const index = await readIndexFile(),
        newIds: string[] = [];
      const guides = new Map<
        string,
        Awaited<ReturnType<typeof readWorkStyleGuide>>
      >();
      for (const item of partial.items) {
        signal.throwIfAborted();
        const target = destinations.get(item.sourceId);
        if (target) {
          if (!index.workOrder.includes(target))
            throw new Error("The selected work is no longer in the library.");
          const guide =
            guides.get(target) ?? (await readWorkStyleGuide(target));
          const incoming = WorkStyleGuideSchema.parse(
            await readBackupJson(
              join(stage, item.sourceId, "style-guide.json"),
            ),
          );
          const plan = planWorkGlossaryImport(guide, {
            ...incoming,
            invalidCount: 0,
          });
          if (plan.glossary.overLimit || plan.characters.overLimit)
            throw new Error(tMain("backup.glossaryFull"));
          const merged = applyWorkGlossaryImport(guide, plan, "keep-existing", {
            now: new Date().toISOString(),
            createId: () => randomUUID(),
          });
          if (merged.added) guides.set(target, merged.guide);
        } else {
          const published = await tx.createPublishedDirectory(
            join(this.paths.libraryDir, "works", item.sourceId),
          );
          await publishWork(stage, item, published.stagingDirectory, signal);
          newIds.push(item.sourceId);
        }
      }
      for (const guide of guides.values()) {
        const prior = Date.parse(guide.updatedAt);
        guide.updatedAt = new Date(
          Math.max(Date.now(), Number.isFinite(prior) ? prior + 1 : 0),
        ).toISOString();
        await stageStyleGuideFile(tx, guide);
      }
      if (newIds.length)
        await stageIndexFile(tx, {
          workOrder: [...index.workOrder, ...newIds],
        });
      tx.beforePublish(async () => {
        signal.throwIfAborted();
        seal();
      });
    });
    this.forget(id);
  }
}

function selectDestinations(partial: PartialPreview, choices: GlossaryTargets) {
  const destinations = new Map<string, string>();
  for (const { sourceId, workId } of choices) {
    if (
      destinations.has(sourceId) ||
      !partial.targets.some((item) => item.id === workId) ||
      !partial.items.some(
        (item) =>
          item.sourceId === sourceId && !item.chapters && item.terms > 0,
      )
    )
      throw new Error("Invalid glossary recovery target.");
    destinations.set(sourceId, workId);
  }
  return destinations;
}
async function publishWork(
  stage: string,
  item: RecoveredWork,
  target: string,
  signal: AbortSignal,
) {
  const source = join(stage, item.sourceId);
  for (const file of await regularFiles(source, "", signal)) {
    signal.throwIfAborted();
    await copyBackupFile(join(source, file), join(target, file), signal);
  }
}
