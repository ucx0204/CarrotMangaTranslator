import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  BlockLibrarySnapshotV1Schema,
  MAX_BLOCK_LIBRARY_ENTRIES,
  createEmptyBlockLibrarySnapshot,
  normalizeBlockLibraryName,
  type BlockLibraryEntryV1,
  type BlockLibrarySnapshotV1,
  type RenameBlockLibraryEntryInput,
  type SaveBlockLibraryEntryInput,
  type UpdateBlockLibraryEntryInput,
} from "../shared/blockLibrary";
import { readJsonFile, writeJsonFile } from "./libraryStore/storage";

const BLOCK_LIBRARY_FILE_NAME = "block-library.json";

export class BlockLibraryStore {
  readonly filePath: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(dataRoot: string) {
    this.filePath = join(dataRoot, BLOCK_LIBRARY_FILE_NAME);
  }

  list(): Promise<BlockLibrarySnapshotV1> {
    return this.runExclusive(() => this.read());
  }

  save(input: SaveBlockLibraryEntryInput): Promise<BlockLibrarySnapshotV1> {
    return this.runExclusive(async () => {
      const snapshot = await this.read();
      if (snapshot.entries.length >= MAX_BLOCK_LIBRARY_ENTRIES) {
        throw new Error(
          `블록 라이브러리는 최대 ${MAX_BLOCK_LIBRARY_ENTRIES}개까지 저장할 수 있습니다.`,
        );
      }
      const timestamp = new Date().toISOString();
      const entry: BlockLibraryEntryV1 = {
        schemaVersion: 1,
        id: randomUUID(),
        name: normalizeBlockLibraryName(input.name),
        createdAt: timestamp,
        updatedAt: timestamp,
        lastUsedAt: timestamp,
        block: input.block,
      };
      const next = BlockLibrarySnapshotV1Schema.parse({
        ...snapshot,
        entries: [entry, ...snapshot.entries],
      });
      await writeJsonFile(this.filePath, next);
      return next;
    });
  }

  rename(input: RenameBlockLibraryEntryInput): Promise<BlockLibrarySnapshotV1> {
    return this.runExclusive(async () => {
      const snapshot = await this.read();
      const timestamp = new Date().toISOString();
      let found = false;
      const entries = snapshot.entries.map((entry) => {
        if (entry.id !== input.id) return entry;
        found = true;
        return {
          ...entry,
          name: normalizeBlockLibraryName(input.name),
          updatedAt: timestamp,
        };
      });
      assertEntryFound(found, input.id);
      const next = BlockLibrarySnapshotV1Schema.parse({ ...snapshot, entries });
      await writeJsonFile(this.filePath, next);
      return next;
    });
  }

  update(input: UpdateBlockLibraryEntryInput): Promise<BlockLibrarySnapshotV1> {
    return this.runExclusive(async () => {
      const snapshot = await this.read();
      const timestamp = new Date().toISOString();
      let found = false;
      const entries = snapshot.entries.map((entry) => {
        if (entry.id !== input.id) return entry;
        found = true;
        return {
          ...entry,
          name: normalizeBlockLibraryName(input.name),
          block: input.block,
          updatedAt: timestamp,
        };
      });
      assertEntryFound(found, input.id);
      const next = BlockLibrarySnapshotV1Schema.parse({ ...snapshot, entries });
      await writeJsonFile(this.filePath, next);
      return next;
    });
  }

  delete(id: string): Promise<BlockLibrarySnapshotV1> {
    return this.runExclusive(async () => {
      const snapshot = await this.read();
      const entries = snapshot.entries.filter((entry) => entry.id !== id);
      assertEntryFound(entries.length !== snapshot.entries.length, id);
      const next = BlockLibrarySnapshotV1Schema.parse({ ...snapshot, entries });
      await writeJsonFile(this.filePath, next);
      return next;
    });
  }

  use(id: string): Promise<BlockLibraryEntryV1> {
    return this.runExclusive(async () => {
      const snapshot = await this.read();
      const timestamp = new Date().toISOString();
      const target = snapshot.entries.find((entry) => entry.id === id);
      if (!target) {
        throw new Error(`블록 라이브러리 항목을 찾을 수 없습니다: ${id}`);
      }
      const used: BlockLibraryEntryV1 = {
        ...target,
        lastUsedAt: timestamp,
      };
      const entries = snapshot.entries.map((entry) =>
        entry.id === id ? used : entry,
      );
      const next = BlockLibrarySnapshotV1Schema.parse({ ...snapshot, entries });
      await writeJsonFile(this.filePath, next);
      return used;
    });
  }

  private async read(): Promise<BlockLibrarySnapshotV1> {
    const raw = await readJsonFile(
      this.filePath,
      createEmptyBlockLibrarySnapshot(),
    );
    return BlockLibrarySnapshotV1Schema.parse(raw);
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function assertEntryFound(found: boolean, id: string): asserts found {
  if (!found) {
    throw new Error(`블록 라이브러리 항목을 찾을 수 없습니다: ${id}`);
  }
}
