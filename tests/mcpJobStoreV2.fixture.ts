import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, vi } from "vitest";
import { McpSecureStore } from "../src/main/mcp/mcpSecureStore";
import { mcpTestEncryption } from "./mcpEncryption.fixture";
import { hashStableValue } from "../src/shared/blockFingerprint";
import type { McpStoredJob } from "../src/main/application/mcpJobJournal";
vi.mock("electron", () => ({
  safeStorage: { isEncryptionAvailable: () => false },
  app: { isPackaged: false },
}));
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
}, 120_000);
export async function jobStoreFixture() {
  const root = await mkdtemp(join(tmpdir(), "mcp-jobs-v2-"));
  directories.push(root);
  const encryption = mcpTestEncryption();
  const errors = vi.fn();
  const secure = () => new McpSecureStore(root, encryption);
  const open = async () => {
    const store = secure().jobPersistence(errors);
    await store.open();
    return store;
  };
  return { root, encryption, errors, secure, open, store: await open() };
}
export function jobRecord(
  result: McpStoredJob["result"] = { status: "completed" },
): McpStoredJob {
  const requestId = randomUUID();
  const parameters = {
    chapterId: "chapter",
    pageId: "page",
    revision: "page-v1:0000000000000000",
    requestId,
  };
  return {
    id: randomUUID(),
    owner: "owner",
    requestId,
    kind: "ocr",
    parameters,
    fingerprint: hashStableValue(["ocr", parameters]),
    status: "completed",
    progress: { phase: "done" },
    startedAt: Date.now(),
    finishedAt: Date.now(),
    cancellationRequested: false,
    result,
  };
}
export async function jobFiles(root: string): Promise<string[]> {
  const names = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const item of names) {
    const path = join(root, item.name);
    if (item.isDirectory()) result.push(...(await jobFiles(path)));
    else result.push(path);
  }
  return result;
}
