import { AsyncReaderWriterLock } from "../libraryStore/mutex";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { retainLibraryArtifacts } from "../libraryStore/libraryArtifactRetention";
import {
  libraryStructureResource,
  type AppActivityResource,
} from "../../shared/appActivityTypes";
import {
  assertLibraryReadable,
  libraryMutationCoordinator,
} from "../libraryStore/libraryMutationCoordinator";
import { withLibraryPublicationRead } from "../libraryStore/libraryPublicationLock";

const libraryLock = new AsyncReaderWriterLock();
const activityOwner = new AsyncLocalStorage<string>();

/** Acquire while holding the library read boundary; release after the last export read. */
export function retainLibrarySnapshot(
  resources: readonly AppActivityResource[],
  paths: readonly string[],
): () => void {
  const pending = libraryMutationCoordinator.begin();
  try {
    const activity = libraryMutationCoordinator.acquireActivity({
      id: randomUUID(),
      ownerId: activityOwner.getStore(),
      category: "operation",
      kind: "export-snapshot",
      resources,
      mutatesLibrary: false,
      blocksQuit: true,
    });
    const release = retainLibraryArtifacts(paths);
    return () => {
      release();
      activity?.release();
      pending.finish();
    };
  } catch (error) {
    pending.finish();
    throw error;
  }
}

export function withLibraryActivityOwner<T>(ownerId: string, run: () => T): T {
  return activityOwner.run(ownerId, run);
}

export function assertLibraryActivityAccess(
  resources: readonly AppActivityResource[],
): void {
  libraryMutationCoordinator.assertActivityAccess(
    resources,
    activityOwner.getStore(),
  );
}

/** Keep image preparation visible to handoff and shutdown without holding the JSON write lock. */
export async function withLibraryContentEdit<T>(
  resources: readonly AppActivityResource[],
  operation: () => Promise<T>,
  waitSignal?: AbortSignal,
): Promise<T> {
  return runLibraryContentEdit(resources, operation, waitSignal);
}

/** Trusted nested native work shares only the owner established by this module.
 * Transport callers cannot supply or replace an activity owner. */
export async function withLibraryOwnedContentEdit<T>(
  resources: readonly AppActivityResource[],
  operation: () => Promise<T>,
  waitSignal?: AbortSignal,
): Promise<T> {
  return runLibraryContentEdit(
    resources,
    operation,
    waitSignal,
    activityOwner.getStore(),
  );
}

async function runLibraryContentEdit<T>(
  resources: readonly AppActivityResource[],
  operation: () => Promise<T>,
  waitSignal?: AbortSignal,
  ownerId?: string,
): Promise<T> {
  const id = randomUUID();
  const descriptor = {
    id,
    ownerId,
    category: "operation" as const,
    kind: "page-edit",
    resources: [
      ...resources,
      ...resources
        .filter((resource) => resource.kind === "page-content")
        .map((resource) =>
          libraryStructureResource(
            "chapter",
            resource.scope.split("/")[0],
            "read",
          ),
        ),
    ],
    mutatesLibrary: true,
    blocksQuit: true,
  };
  const activity = waitSignal
    ? await libraryMutationCoordinator.acquireActivityWhenAvailable(
        descriptor,
        waitSignal,
      )
    : libraryMutationCoordinator.acquireActivity(descriptor);
  try {
    // A queued edit cannot count as a mutation while backup holds its activity
    // and waits for admitted writes to drain. Recheck intake after acquisition.
    const pending = libraryMutationCoordinator.begin();
    try {
      return await withLibraryActivityOwner(ownerId ?? id, operation);
    } finally {
      pending.finish();
    }
  } finally {
    activity?.release();
  }
}

export function withLibraryMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const lease = libraryMutationCoordinator.begin();
  return libraryLock
    .runWrite(async () => {
      libraryMutationCoordinator.assertExecutionAllowed();
      return operation();
    })
    .finally(lease.finish);
}

export function withLibraryRead<T>(operation: () => Promise<T>): Promise<T> {
  assertLibraryReadable();
  return libraryLock.runRead(async () => {
    assertLibraryReadable();
    return operation();
  });
}

/**
 * Navigation reads observe JSON files published through atomic temp-file
 * renames, so they can safely see either the previous or next snapshot without
 * waiting behind an unrelated long-running mutation. Multi-file readers in the
 * navigation facade already treat removed index references as absent.
 *
 * Exports and context operations that require a stable multi-file snapshot must
 * continue to use {@link withLibraryRead}.
 */
export function withLibraryNavigationRead<T>(
  operation: () => Promise<T>,
): Promise<T> {
  assertLibraryReadable();
  return withLibraryPublicationRead(async () => {
    assertLibraryReadable();
    return operation();
  });
}

/** Release unused history artifacts after shutdown has closed user mutation intake. */
export function withLibraryArtifactCleanup<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const lease = libraryMutationCoordinator.beginArtifactCleanup();
  return libraryLock
    .runWrite(async () => {
      libraryMutationCoordinator.assertExecutionAllowed();
      return operation();
    })
    .finally(lease.finish);
}
