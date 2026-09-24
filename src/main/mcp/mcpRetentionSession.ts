import { createMcpContextMigrationSession } from "./mcpContextMigrationSession";
import { withLibraryRead } from "../library/lock";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import type { McpArtifactStore } from "./mcpArtifactStore";
import { wrapRetainedTool } from "./mcpRecoveryCapture";
import { createRecoveryApplication } from "./mcpRecoveryApplication";
import {
  issueRetainedOutput,
  borrowRetainedOutput,
  type McpBorrowedOutputIdentity,
} from "./mcpRetainedOutputs";
import { createMcpRetentionTools } from "./mcpRetentionTools";
import { McpRetentionCatalog } from "./mcpRetentionCatalog";
import { mcpArtifactRequiresImages } from "../../shared/mcpOutputFormats";
import type { RetentionEntry } from "./mcpRetentionRecords";

export function createMcpRetentionSession(
  storage: McpRetentionStorage,
  artifacts: McpArtifactStore,
  app: InpaintingJobContext,
  editing: Parameters<typeof createRecoveryApplication>[2],
  enabled: boolean,
  images: boolean,
  assertDiscardable?: (kind: RetentionEntry["kind"], id: string) => void,
) {
  const lifetime = new AbortController();
  const catalog = new McpRetentionCatalog(
    storage,
    lifetime.signal,
    images,
    assertDiscardable,
  );
  const migrations = createMcpContextMigrationSession(
    storage,
    app,
    editing,
    catalog,
    lifetime.signal,
    enabled,
  );
  const tasks = new Set<Promise<unknown>>();
  const apply = createRecoveryApplication(
    storage,
    app,
    editing,
    lifetime.signal,
  );
  const service = {
    list: catalog.list.bind(catalog),
    change: catalog.change.bind(catalog),
    output: catalog.output.bind(catalog),
    discard: catalog.discard.bind(catalog),
    file: createRetainedFileIssuer(storage, artifacts, lifetime.signal),
    apply: trackRecoveryApplication(apply, tasks),
  };
  return {
    catalog,
    borrowOutput: createRetainedFileIssuer(
      storage,
      artifacts,
      lifetime.signal,
      borrowRetainedOutput,
    ),
    migration: migrations.application,
    tools: [
      ...createMcpRetentionTools(service, enabled, images),
      ...migrations.tools,
    ],
    wrap: (tool: Parameters<typeof wrapRetainedTool>[1]) =>
      wrapRetainedTool(storage, tool),
    ready: () => withLibraryRead(() => storage.index()),
    stop: () => lifetime.abort(),
    close: async () => {
      lifetime.abort();
      await Promise.allSettled([...tasks]);
      await migrations.close();
    },
  };
}

function trackRecoveryApplication(
  apply: ReturnType<typeof createRecoveryApplication>,
  tasks: Set<Promise<unknown>>,
) {
  return (...args: Parameters<typeof apply>) => {
    const task = apply(...args);
    tasks.add(task);
    return task.finally(() => {
      tasks.delete(task);
    });
  };
}

function createRetainedFileIssuer(
  storage: McpRetentionStorage,
  artifacts: McpArtifactStore,
  lifetime: AbortSignal,
  issue: typeof borrowRetainedOutput = issueRetainedOutput,
) {
  return (
    owner: string,
    id: string,
    guard: () => void,
    assertAdditionalScopes: (scopes: readonly string[]) => void,
    expected?: McpBorrowedOutputIdentity,
  ) =>
    issue(
      storage,
      artifacts,
      owner,
      id,
      () => {
        lifetime.throwIfAborted();
        guard();
      },
      (mime) => {
        if (mcpArtifactRequiresImages(mime))
          assertAdditionalScopes(["carrot.read", "carrot.images"]);
      },
      expected,
    );
}
