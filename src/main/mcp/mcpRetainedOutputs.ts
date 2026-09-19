import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { withLibraryMutation, withLibraryRead } from "../library/lock";
import {
  readChapterFile,
  findChapterLocation,
} from "../libraryStore/libraryFiles";
import { runLibraryTransaction } from "../libraryStore/libraryTransaction";
import { copyDurableBackup } from "../libraryStore/libraryTransactionStorage";
import { createPageRevision } from "../../shared/pageRevision";
import { readImageRedactionState } from "../imageRedactionStore";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  RetainedOutputSchema,
  MCP_RETENTION_MS,
  type RetainedOutput,
} from "./mcpRetentionRecords";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import type {
  McpArtifactRetention,
  McpArtifactBinding,
} from "./mcpArtifactTypes";
import type { McpArtifactStore } from "./mcpArtifactStore";
import { currentRetentionInvocation } from "./mcpRecoveryCapture";
import {
  captureRetainedPage,
  inspectRetainedFile,
  verifyRetainedFiles,
} from "./mcpRetentionEvidence";

export function createRetainedOutputPublisher(
  storage: McpRetentionStorage,
): McpArtifactRetention {
  return async (artifact, assertAccess) => {
    const invocation = currentRetentionInvocation();
    if (!invocation)
      throw new McpEditError(
        "access_denied",
        "An owned retained-output invocation is required.",
      );
    await assertAccess();
    return withLibraryMutation(async () => {
      const targets = await captureOutputTargets(artifact.bindings);
      const id = randomUUID();
      return runLibraryTransaction(
        "mcp-retain-output",
        async (transaction) => {
          const index = await storage.prune(transaction, await storage.index());
          const directory = await storage.create(transaction, id);
          const record = RetainedOutputSchema.parse({
            version: 1,
            id,
            owner: invocation.owner,
            mimeType: artifact.mimeType,
            sha256: artifact.sha256,
            bytes: artifact.size,
            targets,
          });
          const digest = await copyDurableBackup(
            artifact.file,
            join(directory.stagingDirectory, `${record.sha256}.bin`),
          );
          if (digest !== record.sha256)
            throw new Error("Output bytes changed before retention.");
          const metadata = await storage.writeRecord(
            directory.stagingDirectory,
            record,
          );
          index.entries.push({
            id,
            owner: invocation.owner,
            operation: invocation.operation,
            requestId: invocation.requestId,
            kind: "output",
            createdAt: storage.now(),
            expiresAt: storage.now() + MCP_RETENTION_MS,
            bytes: artifact.size + metadata,
            pageCount: targets.length,
            mimeType: record.mimeType,
            sha256: record.sha256,
          });
          await storage.stageIndex(transaction, index);
          // The access closure uses navigation reads; do not recursively enter a library read lock here.
          transaction.beforePublish(async () => {
            await checkOutputPages(record, true);
          });
          return id;
        },
        undefined,
        invocation.assertAuthorized,
      );
    });
  };
}
async function captureOutputTargets(bindings: McpArtifactBinding[]) {
  const targets: RetainedOutput["targets"] = [];
  for (const target of new Map(
    bindings.map((item) => [`${item.chapterId}/${item.pageId}`, item]),
  ).values()) {
    const location = await findChapterLocation(target.chapterId);
    const chapter =
      location && (await readChapterFile(location.workId, target.chapterId));
    const page = chapter?.pages.find((page) => page.id === target.pageId);
    if (!chapter || !page || createPageRevision(page) !== target.revision)
      throw new McpEditError(
        "revision_conflict",
        "Output page changed before its bytes were retained.",
      );
    targets.push({
      ...target,
      workId: chapter.workId,
      files: (await captureRetainedPage(page)).files,
    });
  }
  return targets;
}
export async function readRetainedOutput(
  storage: McpRetentionStorage,
  owner: string,
  id: string,
) {
  const { entry } = await storage.owned(owner, id, "output");
  const record = RetainedOutputSchema.parse(await storage.record(id));
  if (
    record.id !== id ||
    record.owner !== owner ||
    record.targets.length !== entry.pageCount ||
    record.sha256 !== entry.sha256 ||
    record.mimeType !== entry.mimeType
  )
    throw new McpEditError(
      "invalid_edit",
      "Retained output metadata is inconsistent.",
    );
  return { entry, record };
}
export async function checkOutputPages(
  record: RetainedOutput,
  hashes: boolean,
) {
  for (const target of record.targets) {
    const location = await findChapterLocation(target.chapterId);
    if (!location || location.workId !== target.workId)
      throw new McpEditError(
        "revision_conflict",
        "Retained output chapter moved or disappeared.",
      );
    const chapter = await readChapterFile(target.workId, target.chapterId);
    const page = chapter?.pages.find((page) => page.id === target.pageId);
    if (!page || createPageRevision(page) !== target.revision)
      throw new McpEditError(
        "revision_conflict",
        "Retained output belongs to a changed page; export the current page explicitly.",
      );
    if (hashes) await verifyRetainedFiles(target.files);
  }
}
export async function issueRetainedOutput(
  storage: McpRetentionStorage,
  artifacts: McpArtifactStore,
  owner: string,
  id: string,
  guard: () => void,
) {
  guard();
  const { record } = await withLibraryRead(() =>
    readRetainedOutput(storage, owner, id),
  );
  const file = await storage.path(id, record.sha256);
  const access = async (hashes = false) => {
    guard();
    if ((await readImageRedactionState()).enabled)
      throw new McpEditError(
        "access_denied",
        "Retained output transfer is blocked by image redaction review.",
      );
    await withLibraryRead(async () => {
      await storage.owned(owner, id, "output");
      await checkOutputPages(record, hashes);
      if (hashes) {
        const actual = await inspectRetainedFile(file);
        if (actual.sha256 !== record.sha256 || actual.bytes !== record.bytes)
          throw new Error("Retained output bytes changed.");
      }
    });
    guard();
  };
  const link = await artifacts.issueRetained(
    file,
    record,
    () => access(),
    () => access(true),
  );
  return {
    id,
    url: link.url,
    bytes: link.bytes,
    sha256: link.sha256,
    mimeType: link.mimeType,
    expiresAt: link.expiresAt,
    access: link.access,
  };
}
