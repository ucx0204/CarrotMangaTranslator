import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "../application/mcpEditPolicy";
import type { LibraryTransaction } from "../libraryStore/libraryTransaction";
import type { McpRetentionStorage } from "./mcpRetentionStorage";

type Identity = { id: string; expiresAt: number };

/** Domain repositories still parse, authorize and validate their complete records. */
export function assertDeletionRecordUnchanged(
  expected: unknown,
  current: unknown,
) {
  if (hashStableValue(expected) !== hashStableValue(current))
    throw new McpEditError(
      "revision_conflict",
      "Deletion recovery changed before publication.",
    );
}

export function assertDeletionRecoveryLive(record: Identity, now: number) {
  if (record.expiresAt <= now)
    throw new McpEditError(
      "not_found",
      "Deletion recovery expired before publication.",
    );
}

/** Re-read through the owning domain repository, not a raw or unvalidated stored value. */
export async function verifyCurrentDeletionRecord<T extends Identity>(
  repository: {
    load(owner: string, id: string): Promise<T>;
    assertLive(record: T): void;
  },
  owner: string,
  expected: T,
  guard: () => void,
) {
  assertDeletionRecordUnchanged(
    expected,
    await repository.load(owner, expected.id),
  );
  repository.assertLive(expected);
  guard();
}

/** A parsed recovery action and its expiry share the existing native commit boundary. */
export async function stageDeletionRecoveryRecord(
  transaction: LibraryTransaction,
  storage: McpRetentionStorage,
  record: Identity,
) {
  assertDeletionRecoveryLive(record, storage.now());
  await storage.stageRecord(transaction, record.id, record);
  transaction.beforePublish(async () =>
    assertDeletionRecoveryLive(record, storage.now()),
  );
}
