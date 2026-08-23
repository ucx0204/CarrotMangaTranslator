import { z } from "zod";
import {
  BlockLibraryEntryIdSchema,
  BlockLibraryEntryV1Schema,
  BlockLibrarySnapshotV1Schema,
  RenameBlockLibraryEntryInputSchema,
  SaveBlockLibraryEntryInputSchema,
  UpdateBlockLibraryEntryInputSchema,
  type BlockLibraryEntryV1,
  type BlockLibrarySnapshotV1,
  type RenameBlockLibraryEntryInput,
  type SaveBlockLibraryEntryInput,
  type UpdateBlockLibraryEntryInput,
} from "./blockLibrary";
import { defineIpcContract } from "./ipcContractCore";

export const blockLibraryIpcContracts = {
  listBlockLibraryEntries: defineIpcContract<[], BlockLibrarySnapshotV1>({
    apiKey: "listBlockLibraryEntries",
    channel: "block-library:list",
    args: z.tuple([]),
    result: BlockLibrarySnapshotV1Schema,
  }),
  saveBlockLibraryEntry: defineIpcContract<
    [SaveBlockLibraryEntryInput],
    BlockLibrarySnapshotV1
  >({
    apiKey: "saveBlockLibraryEntry",
    channel: "block-library:save",
    args: z.tuple([SaveBlockLibraryEntryInputSchema]),
    result: BlockLibrarySnapshotV1Schema,
  }),
  renameBlockLibraryEntry: defineIpcContract<
    [RenameBlockLibraryEntryInput],
    BlockLibrarySnapshotV1
  >({
    apiKey: "renameBlockLibraryEntry",
    channel: "block-library:rename",
    args: z.tuple([RenameBlockLibraryEntryInputSchema]),
    result: BlockLibrarySnapshotV1Schema,
  }),
  updateBlockLibraryEntry: defineIpcContract<
    [UpdateBlockLibraryEntryInput],
    BlockLibrarySnapshotV1
  >({
    apiKey: "updateBlockLibraryEntry",
    channel: "block-library:update",
    args: z.tuple([UpdateBlockLibraryEntryInputSchema]),
    result: BlockLibrarySnapshotV1Schema,
  }),
  deleteBlockLibraryEntry: defineIpcContract<[string], BlockLibrarySnapshotV1>({
    apiKey: "deleteBlockLibraryEntry",
    channel: "block-library:delete",
    args: z.tuple([BlockLibraryEntryIdSchema]),
    result: BlockLibrarySnapshotV1Schema,
  }),
  useBlockLibraryEntry: defineIpcContract<[string], BlockLibraryEntryV1>({
    apiKey: "useBlockLibraryEntry",
    channel: "block-library:use",
    args: z.tuple([BlockLibraryEntryIdSchema]),
    result: BlockLibraryEntryV1Schema,
  }),
} as const;
