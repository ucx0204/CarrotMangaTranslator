import { z } from "zod";
import { join } from "node:path";
import type {
  LinkedSyncQueueFileV1,
  LinkedSyncQueueItemV1,
  LinkedWorkspaceRecordV1,
  LinkedWorkspaceRegistryV1,
} from "../../shared/linkedWorkspaceTypes";
import type { PageVisualRevision } from "../../shared/pageRevision";
import {
  LINKED_SYNC_QUEUE_SCHEMA_VERSION,
  LINKED_WORKSPACE_SCHEMA_VERSION,
} from "../../shared/linkedWorkspaceTypes";
import { RasterExportSettingsSchema } from "../../shared/linkedWorkspaceSchemas";
import { readJsonFile, writeJsonFile } from "../libraryStore/storage";

const visualRevisionSchema = z.custom<PageVisualRevision>(
  (value) =>
    typeof value === "string" && /^page-visual-v1:[0-9a-f]{16}$/.test(value),
);

const linkedWorkspaceRecordSchema = z
  .object({
    id: z.string().uuid(),
    workId: z.string().uuid(),
    chapterId: z.string().uuid(),
    rootPath: z.string().min(1).max(4096),
    destinationKind: z.enum(["managed", "custom"]).optional(),
    enabled: z.boolean(),
    output: RasterExportSettingsSchema,
    pageRelativePaths: z.record(z.string().uuid(), z.string().min(1).max(4096)),
    sourceRelativePaths: z
      .record(z.string().uuid(), z.string().min(1).max(4096))
      .optional(),
    publishedRevisions: z.record(z.string().uuid(), visualRevisionSchema),
    publishedMirrorRevisions: z.record(
      z.string().uuid(),
      z.string().min(1).max(120),
    ),
    sourceFingerprints: z.record(
      z.string().uuid(),
      z
        .object({
          size: z.number().int().nonnegative(),
          mtimeMs: z.number().nonnegative(),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict(),
    ),
    artifacts: z.record(
      z.string().uuid(),
      z
        .object({
          result: z
            .object({
              path: z.string().min(1).max(4096),
              bytes: z.number().int().nonnegative(),
              sha256: z.string().regex(/^[0-9a-f]{64}$/),
            })
            .strict()
            .optional(),
          inpainted: z
            .object({
              path: z.string().min(1).max(4096),
              bytes: z.number().int().nonnegative(),
              sha256: z.string().regex(/^[0-9a-f]{64}$/),
              sourcePath: z.string().min(1).max(4096).optional(),
            })
            .strict()
            .optional(),
          mask: z
            .object({
              path: z.string().min(1).max(4096),
              bytes: z.number().int().nonnegative(),
              sha256: z.string().regex(/^[0-9a-f]{64}$/),
              sourcePath: z.string().min(1).max(4096).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    createdAt: z.string().max(80),
    updatedAt: z.string().max(80),
  })
  .strict();

const registrySchema = z
  .object({
    schemaVersion: z.literal(LINKED_WORKSPACE_SCHEMA_VERSION),
    records: z.array(linkedWorkspaceRecordSchema).max(2000),
  })
  .strict();

const queueItemSchema = z
  .object({
    connectionId: z.string().uuid(),
    chapterId: z.string().uuid(),
    pageId: z.string().uuid(),
    visualRevision: visualRevisionSchema,
    mirrorRevision: z.string().min(1).max(120),
    priority: z.number().int().min(0).max(100),
    attempts: z.number().int().min(0).max(100),
    nextRetryAt: z.number().int().nonnegative(),
    queuedAt: z.number().int().nonnegative(),
    mirrorOnly: z.boolean().optional(),
  })
  .strict();

const queueSchema = z
  .object({
    schemaVersion: z.literal(LINKED_SYNC_QUEUE_SCHEMA_VERSION),
    items: z.array(queueItemSchema).max(20_000),
  })
  .strict();

const EMPTY_REGISTRY: LinkedWorkspaceRegistryV1 = {
  schemaVersion: LINKED_WORKSPACE_SCHEMA_VERSION,
  records: [],
};
const EMPTY_QUEUE: LinkedSyncQueueFileV1 = {
  schemaVersion: LINKED_SYNC_QUEUE_SCHEMA_VERSION,
  items: [],
};

export class LinkedWorkspaceStore {
  private readonly registryPath: string;
  private readonly queuePath: string;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(dataRoot: string) {
    this.registryPath = join(dataRoot, "linked-workspaces.json");
    this.queuePath = join(dataRoot, "linked-sync-queue.json");
  }

  async readRegistry(): Promise<LinkedWorkspaceRegistryV1> {
    return registrySchema.parse(
      await readJsonFile<unknown>(this.registryPath, EMPTY_REGISTRY),
    );
  }

  async readQueue(): Promise<LinkedSyncQueueFileV1> {
    return queueSchema.parse(
      await readJsonFile<unknown>(this.queuePath, EMPTY_QUEUE),
    );
  }

  async replaceRecord(record: LinkedWorkspaceRecordV1): Promise<void> {
    await this.mutateRegistry((registry) => ({
      ...registry,
      records: [
        ...registry.records.filter(
          (candidate) =>
            candidate.id !== record.id &&
            candidate.chapterId !== record.chapterId,
        ),
        linkedWorkspaceRecordSchema.parse(record),
      ],
    }));
  }

  async removeRecord(connectionId: string): Promise<boolean> {
    let removed = false;
    await this.mutateRegistry((registry) => {
      const records = registry.records.filter((record) => {
        const keep = record.id !== connectionId;
        removed ||= !keep;
        return keep;
      });
      return { ...registry, records };
    });
    if (removed) {
      await this.replaceQueueItems(
        (await this.readQueue()).items.filter(
          (item) => item.connectionId !== connectionId,
        ),
      );
    }
    return removed;
  }

  async replaceQueueItems(items: LinkedSyncQueueItemV1[]): Promise<void> {
    await this.runExclusive(async () => {
      const checked = queueSchema.parse({
        schemaVersion: LINKED_SYNC_QUEUE_SCHEMA_VERSION,
        items,
      });
      await writeJsonFile(this.queuePath, checked);
    });
  }

  private async mutateRegistry(
    mutation: (
      registry: LinkedWorkspaceRegistryV1,
    ) => LinkedWorkspaceRegistryV1,
  ): Promise<void> {
    await this.runExclusive(async () => {
      const current = await this.readRegistry();
      const next = registrySchema.parse(mutation(current));
      await writeJsonFile(this.registryPath, next);
    });
  }

  private async runExclusive(operation: () => Promise<void>): Promise<void> {
    const run = this.mutationChain.then(operation, operation);
    this.mutationChain = run.catch((error: unknown) => {
      // The caller still awaits `run` below and receives this failure. Only the
      // private serialization tail is settled so a failed write cannot poison
      // every later registry or queue mutation.
      void error;
    });
    await run;
  }
}
