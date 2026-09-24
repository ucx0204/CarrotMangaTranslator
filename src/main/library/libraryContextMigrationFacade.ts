import type { McpContextReferenceSnapshot } from "../../shared/mcpContextReferences";
import type { ContextMigrationDelta } from "../../shared/mcpContextMigrationState";
import { pageContentResource } from "../../shared/appActivityTypes";
import {
  runLibraryTransaction,
  type LibraryTransaction,
} from "../libraryStore/libraryTransaction";
import {
  captureWorkContextMetadata,
  stageWorkContextMigration,
} from "../libraryStore/workContextMigration";
import {
  readWorkContextEditSnapshotUnlocked,
  readWorkContextReferencesUnlocked,
} from "./libraryContextEditingFacade";
import { assertLibraryActivityAccess, withLibraryMutation } from "./lock";

type Prepared<T> =
  | { skip: true; result: T }
  | {
      skip: false;
      result: T;
      delta: ContextMigrationDelta;
      direction: "apply" | "undo" | "redo";
      guideBeforePresent: boolean;
      verify: (current: McpContextReferenceSnapshot) => void;
      receipt: (transaction: LibraryTransaction) => Promise<void>;
    };

/** Catalog, reference files and history share the existing native commit point. */
export function commitWorkContextMigration<T>(
  chapterId: string,
  prepare: (
    current: McpContextReferenceSnapshot,
    guidePresent: boolean,
    memoryPresence: ReadonlyMap<string, boolean>,
  ) => Promise<Prepared<T>>,
  guard: () => void,
): Promise<T> {
  return withLibraryMutation(async () => {
    guard();
    const anchor = await readWorkContextEditSnapshotUnlocked(chapterId);
    const evidence = await captureWorkContextMetadata(anchor.workId, guard);
    const current = await readWorkContextReferencesUnlocked(chapterId, guard);
    if (current.workId !== anchor.workId)
      throw new Error("Context work membership changed.");
    await evidence.verify();
    const prepared = await prepare(
      current,
      evidence.guidePresent,
      evidence.memoryPresence,
    );
    guard();
    if (prepared.skip) return prepared.result;
    assertLibraryActivityAccess([
      { kind: "work-context", scope: current.workId, access: "write" },
      ...prepared.delta.pages.map((page) =>
        pageContentResource(page.chapterId, page.pageId),
      ),
    ]);
    return runLibraryTransaction(
      "mcp-work-context-migration",
      async (transaction) => {
        await stageWorkContextMigration(
          transaction,
          current.workId,
          prepared.delta,
          prepared.direction,
          prepared.guideBeforePresent,
          guard,
        );
        await prepared.receipt(transaction);
        transaction.beforePublish(async () => {
          guard();
          await evidence.verify();
          prepared.verify(
            await readWorkContextReferencesUnlocked(chapterId, guard),
          );
          guard();
        });
        return prepared.result;
      },
      undefined,
      guard,
    );
  });
}
