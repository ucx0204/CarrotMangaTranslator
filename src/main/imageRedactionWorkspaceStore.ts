import { resolve } from "node:path";
import type { RedactionDraftScope } from "./application/redactionWorkspacePorts";
import type { RedactionWorkspaceDiskState } from "./imageRedactionWorkspaceDiskSchema";
import {
  readRedactionSnapshot,
  writeRedactionSnapshot,
} from "./imageRedactionWorkspaceSnapshot";

import { maintainRedactionDraftObjects } from "./imageRedactionWorkspaceCleanup";

const tails = new Map<string, Promise<void>>();

/** Reads share the root queue so readers never hold an index across draft cleanup. */
export function readRedactionWorkspaceStore(
  root: string,
  scope?: RedactionDraftScope,
): Promise<RedactionWorkspaceDiskState> {
  return exclusive(
    root,
    async () => (await readRedactionSnapshot(root, scope)).state,
  );
}

/** Local drafts only: a successful atomic index write does not approve a job. */
export function updateRedactionWorkspaceStore(
  root: string,
  change: (state: RedactionWorkspaceDiskState) => Promise<void>,
  scope?: RedactionDraftScope,
): Promise<number> {
  return exclusive(root, async () => {
    const snapshot = await readRedactionSnapshot(root, scope);
    await change(snapshot.state);
    const index = await writeRedactionSnapshot(root, snapshot);
    await maintainRedactionDraftObjects(root, index);
    return index.revision;
  });
}
function exclusive<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const task = (tails.get(key) ?? Promise.resolve()).then(operation);
  const tail = task.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return task;
}
