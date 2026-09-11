import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_REDACTION_PREFERENCES } from "../shared/imageRedactionWorkspace";
import {
  redactionWorkspaceDiskSchema,
  type RedactionWorkspaceDiskState,
} from "./imageRedactionWorkspaceDiskSchema";

const MAX_STATE_BYTES = 64 * 1024 * 1024;
let writeTail: Promise<unknown> = Promise.resolve();

export async function readRedactionWorkspaceStore(
  root: string,
): Promise<RedactionWorkspaceDiskState> {
  try {
    const bytes = await readFile(
      join(root, "manual-redaction-workspaces.json"),
    );
    if (bytes.length > MAX_STATE_BYTES)
      throw new Error("가리기 초안 저장 파일이 지원 크기를 초과했습니다.");
    return redactionWorkspaceDiskSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      version: 1,
      revision: 0,
      pages: {},
      views: {},
      preferences: { ...DEFAULT_REDACTION_PREFERENCES },
      presets: [],
    };
  }
}

/** Local drafts only. This function never approves or starts an external job. */
export function updateRedactionWorkspaceStore(
  root: string,
  change: (state: RedactionWorkspaceDiskState) => Promise<void>,
): Promise<number> {
  const operation = writeTail.then(async () => {
    const state = await readRedactionWorkspaceStore(root);
    await change(state);
    state.revision++;
    const bytes = Buffer.from(
      JSON.stringify(redactionWorkspaceDiskSchema.parse(state)),
      "utf8",
    );
    if (bytes.length > MAX_STATE_BYTES)
      throw new Error(
        "가리기 초안이 저장 한도를 초과했습니다. 기존 초안은 보존됩니다.",
      );
    await writeSnapshot(root, bytes);
    return state.revision;
  });
  writeTail = operation.catch((error: unknown) =>
    console.error("Manual redaction draft save failed", error),
  );
  return operation;
}

async function writeSnapshot(root: string, bytes: Buffer): Promise<void> {
  await mkdir(root, { recursive: true });
  const temporary = join(root, `manual-redaction-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(root, "manual-redaction-workspaces.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}
