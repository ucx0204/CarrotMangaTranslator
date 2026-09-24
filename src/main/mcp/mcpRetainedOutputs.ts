import { randomUUID } from "node:crypto";
import type { MangaPage } from "../../shared/libraryTypes";
import { hashStableValue } from "../../shared/blockFingerprint";
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
import { checkMcpWorkFileExportBindingUnlocked } from "./mcpWorkFileExportSource";
import { readMcpExportSourceName } from "./mcpSourceExport";
import {
  mcpArtifactRequiresImages,
  type McpArtifactMime,
} from "../../shared/mcpOutputFormats";
import { checkMcpExchangeBindingUnlocked } from "./mcpExchangeSources";
import {
  captureRetainedPage,
  verifyRetainedFiles,
  watchRetainedFiles,
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
            workFileBinding: artifact.workFileBinding,
            exchangeBinding: artifact.exchangeBinding,
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
            pageCount: retainedOutputPageCount(record),
            mimeType: record.mimeType,
            sha256: record.sha256,
          });
          await storage.stageIndex(transaction, index);
          // The access closure uses navigation reads; do not recursively enter a library read lock here.
          transaction.beforePublish(async () => {
            await checkOutputPages(record, true, () => {
              artifact.signal?.throwIfAborted();
              invocation.assertAuthorized();
            });
          });
          return id;
        },
        undefined,
        () => {
          artifact.signal?.throwIfAborted();
          invocation.assertAuthorized();
        },
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
    const files = (await captureRetainedPage(page)).files;
    assertSourceName(page, target.sourceNameFingerprint);
    if (
      target.sourceFingerprint &&
      target.sourceFingerprint !== hashStableValue(files)
    )
      throw new McpEditError(
        "revision_conflict",
        "Original image evidence changed since rendering.",
      );
    targets.push({
      chapterId: target.chapterId,
      pageId: target.pageId,
      revision: target.revision,
      workId: chapter.workId,
      files,
      ...(target.sourceNameFingerprint
        ? { sourceNameFingerprint: target.sourceNameFingerprint }
        : {}),
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
    retainedOutputPageCount(record) !== entry.pageCount ||
    record.sha256 !== entry.sha256 ||
    record.mimeType !== entry.mimeType
  )
    throw new McpEditError(
      "invalid_edit",
      "Retained output metadata is inconsistent.",
    );
  return { entry, record };
}
function retainedOutputPageCount(record: RetainedOutput) {
  return record.exchangeBinding?.kind === "text"
    ? record.exchangeBinding.pages.length
    : record.targets.length;
}
export async function checkOutputPages(
  record: RetainedOutput,
  hashes: boolean,
  guard: () => void = () => {},
) {
  guard();
  if (record.exchangeBinding)
    await checkMcpExchangeBindingUnlocked(record.exchangeBinding, guard);
  if (record.workFileBinding)
    await checkMcpWorkFileExportBindingUnlocked(record.workFileBinding);
  for (const target of record.targets) {
    guard();
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
    assertSourceName(page, target.sourceNameFingerprint);
  }
  guard();
}
export async function borrowRetainedOutput(
  storage: McpRetentionStorage,
  artifacts: McpArtifactStore,
  owner: string,
  id: string,
  guard: () => void,
  authorizeFormat: (mime: McpArtifactMime) => void = () => {},
  expected?: McpBorrowedOutputIdentity,
) {
  guard();
  const { record } = await withLibraryRead(() =>
    readRetainedOutput(storage, owner, id),
  );
  assertBorrowedIdentity(record, expected);
  const file = await storage.path(id, record.sha256);
  let verifyFiles: (() => Promise<void>) | undefined;
  const access = async (hashes = false) => {
    guard();
    authorizeFormat(record.mimeType);
    if (
      mcpArtifactRequiresImages(record.mimeType) &&
      (await readImageRedactionState()).enabled
    )
      throw new McpEditError(
        "access_denied",
        "Retained output transfer is blocked by image redaction review.",
      );
    await withLibraryRead(async () => {
      await storage.owned(owner, id, "output");
      await checkOutputPages(record, hashes, guard);
      if (hashes) {
        verifyFiles = await watchRetainedFiles([
          ...record.targets.flatMap((target) => target.files),
          {
            path: file,
            sha256: record.sha256,
            bytes: record.bytes,
            asset: record.sha256,
          },
        ]);
      }
      await verifyFiles?.();
    });
    guard();
    authorizeFormat(record.mimeType);
  };
  const link = await artifacts.issueRetained(
    file,
    {
      ...record,
      retainedOutputId: id,
      bindings: record.targets.map(
        ({ chapterId, pageId, revision, sourceNameFingerprint }) => ({
          chapterId,
          pageId,
          revision,
          ...(sourceNameFingerprint ? { sourceNameFingerprint } : {}),
        }),
      ),
    },
    () => access(),
    () => access(true),
  );
  guard();
  authorizeFormat(record.mimeType);
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

/** Internal ZIP borrowing retains all byte/source/access checks without claiming host delivery. */
export type McpBorrowedOutputIdentity = {
  chapterId: string;
  pageId: string;
  revision: string;
  mimeType: McpArtifactMime;
  bytes: number;
  sha256: string;
};
function assertBorrowedIdentity(
  record: RetainedOutput,
  expected?: McpBorrowedOutputIdentity,
) {
  if (!expected) return;
  const target = record.targets[0];
  if (
    record.targets.length !== 1 ||
    record.workFileBinding ||
    record.exchangeBinding ||
    !target ||
    target.chapterId !== expected.chapterId ||
    target.pageId !== expected.pageId ||
    target.revision !== expected.revision ||
    record.mimeType !== expected.mimeType ||
    record.bytes !== expected.bytes ||
    record.sha256 !== expected.sha256
  )
    throw new McpEditError(
      "invalid_edit",
      "Retained file does not match the exact owned page export.",
    );
}
export async function issueRetainedOutput(
  storage: McpRetentionStorage,
  artifacts: McpArtifactStore,
  owner: string,
  id: string,
  guard: () => void,
  authorizeFormat: (mime: McpArtifactMime) => void = () => {},
) {
  const link = await borrowRetainedOutput(
    storage,
    artifacts,
    owner,
    id,
    guard,
    authorizeFormat,
  );
  await artifacts.disclosed(link.url, false);
  return link;
}

/** Bind the actual file evidence BEFORE rendering; native storage rechecks it before publication. */
export async function bindRetainedOutputSource(page: MangaPage) {
  const { files } = await captureRetainedPage(page);
  return {
    fingerprint: hashStableValue(files),
    sourceNameFingerprint: readMcpExportSourceName(page).sourceNameFingerprint,
    verify: (latestPage?: MangaPage, sourceNameFingerprint?: string) => {
      assertSourceName(latestPage, sourceNameFingerprint);
      return verifyRetainedFiles(files);
    },
  };
}
function assertSourceName(
  page: Pick<MangaPage, "name" | "sourceFileName"> | undefined,
  expected?: string,
) {
  if (
    expected &&
    (!page || readMcpExportSourceName(page).sourceNameFingerprint !== expected)
  )
    throw new McpEditError(
      "revision_conflict",
      "Saved source naming changed; review source-format output again.",
    );
}
