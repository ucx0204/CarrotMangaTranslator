import { AsyncLocalStorage } from "node:async_hooks";
import type { ChapterFile } from "./libraryFiles";
import type { LibraryTransaction } from "./libraryTransaction";

type Participant = (
  transaction: LibraryTransaction,
  chapter: ChapterFile,
) => Promise<void>;
const participants = new AsyncLocalStorage<Participant>();

/** Opt-in transaction participant. The caller's context follows the native library queue.
 * Normal UI writes have no participant, and the library never depends on MCP adapters. */
export function withLibraryChapterHistory<T>(
  participant: Participant,
  run: () => T,
): T {
  return participants.run(participant, run);
}
export async function stageLibraryChapterHistory(
  transaction: LibraryTransaction,
  chapter: ChapterFile,
): Promise<void> {
  await participants.getStore()?.(transaction, chapter);
}
