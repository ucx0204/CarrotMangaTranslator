import { join } from "node:path";
import { readIndexFile, readWorkFile } from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import { stageIndexFile } from "./libraryTransactionFiles";
import type { LibraryTransaction } from "./libraryTransaction";

/** Caller holds the normal library boundary. Desktop deletion and reviewed recovery share this publication. */
export async function prepareWorkDeletionUnlocked(workId: string) {
  const work = await readWorkFile(workId);
  if (!work) throw new Error("작품을 찾지 못했습니다.");
  const index = await readIndexFile();
  return {
    work,
    index,
    after: { workOrder: index.workOrder.filter((id) => id !== workId) },
  };
}

/** Verified recovery must be staged by the caller in this SAME native transaction. */
export async function stageWorkDeletionUnlocked(
  transaction: LibraryTransaction,
  workId: string,
  after: Awaited<ReturnType<typeof readIndexFile>>,
) {
  if (after.workOrder.includes(workId))
    throw new Error("Removed work is still listed in the library index.");
  await stageIndexFile(transaction, after);
  await transaction.retireDirectory(join(getWorksRoot(), workId), {
    required: true,
  });
}
