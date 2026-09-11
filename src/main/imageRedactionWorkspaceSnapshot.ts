import { join } from "node:path";
import type { RedactionDraftScope } from "./application/redactionWorkspacePorts";
import {
  redactionWorkspaceDiskSchema,
  type RedactionWorkspaceDiskState,
} from "./imageRedactionWorkspaceDiskSchema";
import {
  emptyRedactionDraft,
  redactionWorkspaceIndexSchema,
  retainRedactionViews,
  type RedactionWorkspaceIndex,
} from "./imageRedactionWorkspaceIndex";
import {
  encodeRedactionRecord,
  persistRedactionRecord,
  readRedactionObject,
  readRedactionRecord,
  redactionObjectDirectory,
  redactionObjectHash,
  REDACTION_INDEX_FILE,
  writeRedactionObject,
  type RedactionDiskWriter,
} from "./imageRedactionWorkspaceObjects";

type Snapshot = {
  state: RedactionWorkspaceDiskState;
  index?: RedactionWorkspaceIndex;
  legacy?: Buffer;
  scope?: RedactionDraftScope;
};
export async function readRedactionSnapshot(
  root: string,
  scope?: RedactionDraftScope,
): Promise<Snapshot> {
  let bytes: Buffer;
  try {
    bytes = await readRedactionRecord(join(root, REDACTION_INDEX_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { state: emptyRedactionDraft(), scope };
  }
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  const parsed = redactionWorkspaceIndexSchema.safeParse(raw);
  if (!parsed.success)
    return {
      state: redactionWorkspaceDiskSchema.parse(raw),
      legacy: bytes,
      scope,
    };
  const index = parsed.data;
  const pageRefs = selectRefs(index.pages, scope?.paths);
  const viewRefs = selectRefs(
    Object.fromEntries(
      Object.entries(index.views).map(([key, value]) => [key, value.object]),
    ),
    scope ? [scope.scopeKey] : undefined,
  );
  const state = redactionWorkspaceDiskSchema.parse({
    version: 1,
    revision: index.revision,
    pages: await readObjects(root, pageRefs),
    views: await readObjects(root, viewRefs),
    preferences: await readRedactionObject(root, index.preferences),
    presets: await readRedactionObject(root, index.presets),
  });
  return { state, index, scope };
}
function selectRefs(
  references: Record<string, string>,
  keys?: readonly string[],
): Record<string, string> {
  if (!keys) return references;
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(references, key))
      .map((key) => [key, references[key]]),
  );
}
async function readObjects(
  root: string,
  references: Record<string, string>,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(references);
  const result: Record<string, unknown> = {};
  for (let offset = 0; offset < entries.length; offset += 4)
    await Promise.all(
      entries.slice(offset, offset + 4).map(async ([key, hash]) => {
        result[key] = await readRedactionObject(root, hash);
      }),
    );
  return result;
}

/** Publish the small index only after every immutable object is durable. */
export async function writeRedactionSnapshot(
  root: string,
  loaded: Snapshot,
  persist: RedactionDiskWriter = persistRedactionRecord,
): Promise<RedactionWorkspaceIndex> {
  const state = redactionWorkspaceDiskSchema.parse(loaded.state);
  const index: RedactionWorkspaceIndex = {
    version: 2,
    revision: state.revision + 1,
    pages: { ...loaded.index?.pages },
    views: { ...loaded.index?.views },
    preferences: await writeRedactionObject(
      root,
      state.preferences,
      loaded.index?.preferences,
      persist,
    ),
    presets: await writeRedactionObject(
      root,
      state.presets,
      loaded.index?.presets,
      persist,
    ),
  };
  await writePages(root, { ...loaded, state }, index, persist);
  await writeViews(root, { ...loaded, state }, index, persist);
  index.views = retainRedactionViews(index.views);
  if (loaded.legacy) {
    const directory = await redactionObjectDirectory(root, true);
    await persist(
      join(directory, `legacy-${redactionObjectHash(loaded.legacy)}.json`),
      loaded.legacy,
    );
  }
  const bytes = encodeRedactionRecord(
    redactionWorkspaceIndexSchema.parse(index),
  );
  await persist(join(root, REDACTION_INDEX_FILE), bytes);
  return index;
}

async function writePages(
  root: string,
  loaded: Snapshot,
  index: RedactionWorkspaceIndex,
  persist: RedactionDiskWriter,
): Promise<void> {
  const state = loaded.state;
  const paths =
    loaded.index && loaded.scope
      ? loaded.scope.paths
      : Object.keys(index.pages);
  for (const path of paths)
    if (!Object.hasOwn(state.pages, path)) delete index.pages[path];
  for (const [path, document] of Object.entries(state.pages))
    index.pages[path] = await writeRedactionObject(
      root,
      document,
      index.pages[path],
      persist,
    );
}
async function writeViews(
  root: string,
  loaded: Snapshot,
  index: RedactionWorkspaceIndex,
  persist: RedactionDiskWriter,
): Promise<void> {
  const state = loaded.state;
  const scopes =
    loaded.index && loaded.scope
      ? [loaded.scope.scopeKey]
      : Object.keys(index.views);
  for (const scope of scopes)
    if (!Object.hasOwn(state.views, scope)) delete index.views[scope];
  for (const [scope, view] of Object.entries(state.views))
    index.views[scope] = {
      object: await writeRedactionObject(
        root,
        view,
        index.views[scope]?.object,
        persist,
      ),
      touched:
        !loaded.scope || scope === loaded.scope.scopeKey ? Date.now() : 0,
    };
}
