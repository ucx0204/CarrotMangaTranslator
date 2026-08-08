import { z } from "zod";

export const LIBRARY_TRANSACTION_SCHEMA_VERSION = 1;
const MAX_LIBRARY_TRANSACTION_STEPS = 20_000;
export const MAX_LIBRARY_TRANSACTION_JOURNAL_BYTES = 16 * 1024 * 1024;

const RelativePathSchema = z.string().min(1).max(4096);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const ReplaceFileStepSchema = z
  .object({
    kind: z.literal("replace-file"),
    target: RelativePathSchema,
    staged: RelativePathSchema,
    stagedSha256: Sha256Schema,
    hadOriginal: z.boolean(),
    backup: RelativePathSchema.optional(),
    backupSha256: Sha256Schema.optional(),
  })
  .strict();

const PublishDirectoryStepSchema = z
  .object({
    kind: z.literal("publish-directory"),
    target: RelativePathSchema,
    staged: RelativePathSchema,
    ownerMarker: RelativePathSchema,
  })
  .strict();

const RetirePathStepSchema = z
  .object({
    kind: z.literal("retire-path"),
    target: RelativePathSchema,
    trash: RelativePathSchema,
    pathType: z.enum(["file", "directory"]),
    required: z.boolean(),
  })
  .strict();

const LibraryTransactionStepSchema = z.discriminatedUnion("kind", [
  ReplaceFileStepSchema,
  PublishDirectoryStepSchema,
  RetirePathStepSchema,
]);

export const LibraryTransactionJournalSchema = z
  .object({
    schemaVersion: z.literal(LIBRARY_TRANSACTION_SCHEMA_VERSION),
    id: z.string().uuid(),
    kind: z.string().min(1).max(100),
    createdAt: z.string().datetime(),
    sealed: z.boolean(),
    steps: z
      .array(LibraryTransactionStepSchema)
      .max(MAX_LIBRARY_TRANSACTION_STEPS),
  })
  .strict();

export type ReplaceFileStep = z.infer<typeof ReplaceFileStepSchema>;
export type PublishDirectoryStep = z.infer<typeof PublishDirectoryStepSchema>;
export type RetirePathStep = z.infer<typeof RetirePathStepSchema>;
export type LibraryTransactionStep = z.infer<
  typeof LibraryTransactionStepSchema
>;
export type LibraryTransactionJournal = z.infer<
  typeof LibraryTransactionJournalSchema
>;

export type LibraryTransactionOwnerMarker = {
  schemaVersion: 1;
  transactionId: string;
  target: string;
};
