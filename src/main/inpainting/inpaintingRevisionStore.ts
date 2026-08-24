/* eslint-disable max-lines -- transaction history, rollback, and artifact retention share one serialized state owner */
import { randomUUID } from "node:crypto";
import type {
  ApplyInpaintingHistoryTransactionRequest,
  ApplyInpaintingHistoryTransactionResult,
  InpaintingHistoryTransactionRef,
} from "../../shared/inpaintingTypes";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { InpaintingArtifactCleanupOptions } from "../libraryStore/libraryInpaintingMutations";
import { logInpaintingRuntimeWarn } from "./inpaintingRuntimeLogger";
import {
  assertRevisionLayoutPair,
  cloneTranslationCompletion,
  groupChangesByChapter,
  InpaintingRevisionRollbackError,
  sameOptionalPath,
  translationCompletionsEqual,
  uniqueRevisionChanges,
  type InpaintingRevisionChange,
} from "./inpaintingRevisionHelpers";
import {
  cloneInpaintingLayoutStates,
  inpaintingLayoutStatesEqual,
  type InpaintingPageLayoutPatch,
} from "./inpaintingLayoutState";
import { prepareInpaintingPageRevision } from "./inpaintingRevisionPreparation";
import {
  libraryInpaintingRevisionRepository,
  type InpaintingRevisionRepository,
} from "./inpaintingRevisionRepository";

export type { InpaintingRevisionChange };

export type InpaintingRevisionDiagnostics = {
  warn: (message: string, detail?: unknown) => void;
};

const productionDiagnostics: InpaintingRevisionDiagnostics = {
  warn: logInpaintingRuntimeWarn,
};

type InpaintingRevisionTransaction = {
  id: string;
  changes: InpaintingRevisionChange[];
};

type PreparedChapterRevision = {
  nextPages: MangaPage[];
  originalPages: MangaPage[];
  nextLayoutPatches: InpaintingPageLayoutPatch[];
  originalLayoutPatches: InpaintingPageLayoutPatch[];
};

export class InpaintingRevisionStore {
  private readonly transactions = new Map<
    string,
    InpaintingRevisionTransaction
  >();
  private cleanupTail: Promise<void> = Promise.resolve();
  private pendingCleanupChanges: InpaintingRevisionChange[] = [];
  private transactionOperationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: InpaintingRevisionRepository = libraryInpaintingRevisionRepository,
    private readonly diagnostics: InpaintingRevisionDiagnostics = productionDiagnostics,
  ) {}

  beginTransaction(): string {
    const id = randomUUID();
    this.transactions.set(id, { id, changes: [] });
    return id;
  }

  addChange(transactionId: string, change: InpaintingRevisionChange): boolean {
    const transaction = this.requireTransaction(transactionId);
    assertRevisionLayoutPair(change);
    if (
      sameOptionalPath(change.beforePath, change.afterPath) &&
      sameOptionalPath(change.beforeMaskPath, change.afterMaskPath) &&
      change.beforeMaskProvenance === change.afterMaskProvenance &&
      inpaintingLayoutStatesEqual(change.beforeLayout, change.afterLayout) &&
      translationCompletionsEqual(
        change.beforeTranslationCompletion,
        change.afterTranslationCompletion,
      )
    ) {
      return false;
    }
    if (
      transaction.changes.some(
        (candidate) =>
          candidate.chapterId === change.chapterId &&
          candidate.pageId === change.pageId,
      )
    ) {
      throw new Error(
        "하나의 인페인팅 기록에 같은 페이지를 중복 등록할 수 없습니다.",
      );
    }
    transaction.changes.push({
      ...change,
      beforeLayout: cloneInpaintingLayoutStates(change.beforeLayout),
      afterLayout: cloneInpaintingLayoutStates(change.afterLayout),
      beforeTranslationCompletion: cloneTranslationCompletion(
        change.beforeTranslationCompletion,
      ),
      afterTranslationCompletion: cloneTranslationCompletion(
        change.afterTranslationCompletion,
      ),
    });
    return true;
  }

  async removeChange(
    transactionId: string,
    chapterId: string,
    pageId: string,
  ): Promise<void> {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      return;
    }
    const removed = transaction.changes.filter(
      (change) => change.chapterId === chapterId && change.pageId === pageId,
    );
    transaction.changes = transaction.changes.filter(
      (change) => change.chapterId !== chapterId || change.pageId !== pageId,
    );
    await this.cleanupReleasedChanges(removed);
  }

  discardIfEmpty(transactionId: string): void {
    const transaction = this.transactions.get(transactionId);
    if (transaction?.changes.length === 0) {
      this.transactions.delete(transactionId);
    }
  }

  getReference(
    transactionId: string | null | undefined,
  ): InpaintingHistoryTransactionRef | undefined {
    if (!transactionId) {
      return undefined;
    }
    const transaction = this.transactions.get(transactionId);
    return transaction && transaction.changes.length > 0
      ? { transactionId }
      : undefined;
  }

  getRetainedArtifactPaths(
    chapterId: string,
    additionalPaths?: string[],
  ): string[] {
    const paths = new Set(additionalPaths ?? []);
    for (const transaction of this.transactions.values()) {
      for (const change of transaction.changes) {
        if (change.chapterId !== chapterId) {
          continue;
        }
        if (change.beforePath) {
          paths.add(change.beforePath);
        }
        if (change.afterPath) {
          paths.add(change.afterPath);
        }
        if (change.beforeMaskPath) {
          paths.add(change.beforeMaskPath);
        }
        if (change.afterMaskPath) {
          paths.add(change.afterMaskPath);
        }
      }
    }
    return [...paths];
  }

  async applyTransaction(
    request: ApplyInpaintingHistoryTransactionRequest,
  ): Promise<ApplyInpaintingHistoryTransactionResult> {
    return this.runTransactionOperation(() =>
      this.applyTransactionNow(request),
    );
  }

  private async applyTransactionNow(
    request: ApplyInpaintingHistoryTransactionRequest,
  ): Promise<ApplyInpaintingHistoryTransactionResult> {
    const transaction = this.requireTransaction(request.transactionId);
    if (transaction.changes.length === 0) {
      throw new Error("비어 있는 인페인팅 작업 기록입니다.");
    }

    try {
      const chapters = await this.repository.runMutation(() =>
        this.applyTransactionUnlocked(transaction, request.direction),
      );
      return {
        transactionId: transaction.id,
        direction: request.direction,
        chapters,
        pagesChanged: transaction.changes.length,
        invalidated: false,
      };
    } catch (error) {
      if (error instanceof InpaintingRevisionRollbackError) {
        this.transactions.delete(transaction.id);
        await this.cleanupReleasedChanges(transaction.changes);
        return {
          transactionId: transaction.id,
          direction: request.direction,
          chapters: error.currentChapters,
          pagesChanged: transaction.changes.length,
          invalidated: true,
        };
      }
      throw error;
    }
  }

  async releaseTransactions(transactionIds: string[]): Promise<number> {
    return this.runTransactionOperation(() =>
      this.releaseTransactionsNow([...transactionIds]),
    );
  }

  private async releaseTransactionsNow(
    transactionIds: string[],
  ): Promise<number> {
    const releasedChanges: InpaintingRevisionChange[] = [];
    let released = 0;
    for (const transactionId of new Set(transactionIds)) {
      const transaction = this.transactions.get(transactionId);
      if (!transaction) {
        continue;
      }
      this.transactions.delete(transactionId);
      releasedChanges.push(...transaction.changes);
      released += 1;
    }
    await this.cleanupReleasedChanges(releasedChanges);
    return released;
  }

  async releaseAll(): Promise<number> {
    const transactionIds = [...this.transactions.keys()];
    return this.runTransactionOperation(async () => {
      const released = await this.releaseTransactionsNow(transactionIds);
      await this.cleanupReleasedChanges([]);
      return released;
    });
  }

  private runTransactionOperation<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.transactionOperationTail.then(operation, operation);
    this.transactionOperationTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  private requireTransaction(
    transactionId: string,
  ): InpaintingRevisionTransaction {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      throw new Error("인페인팅 작업 기록을 찾지 못했습니다.");
    }
    return transaction;
  }

  private async applyTransactionUnlocked(
    transaction: InpaintingRevisionTransaction,
    direction: "undo" | "redo",
  ): Promise<ChapterSnapshot[]> {
    const prepared = await this.prepareTransactionApply(transaction, direction);
    let applyError: unknown;
    try {
      const saved: ChapterSnapshot[] = [];
      for (const [chapterId, revision] of prepared) {
        saved.push(
          await this.repository.savePages(
            chapterId,
            revision.nextPages,
            this.mutationOptionsForChapter(
              chapterId,
              revision.nextLayoutPatches,
            ),
          ),
        );
      }
      return saved;
    } catch (error) {
      applyError = error;
    }

    const rollbackErrors: unknown[] = [];
    for (const [chapterId, revision] of prepared) {
      try {
        await this.repository.savePages(
          chapterId,
          revision.originalPages,
          this.mutationOptionsForChapter(
            chapterId,
            revision.originalLayoutPatches,
          ),
        );
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      const currentChapters = await Promise.all(
        [...prepared.keys()].map((chapterId) =>
          this.repository.readChapterAfterRollbackFailure(chapterId),
        ),
      );
      throw new InpaintingRevisionRollbackError(
        applyError,
        rollbackErrors,
        currentChapters.filter(
          (chapter): chapter is ChapterSnapshot => chapter !== undefined,
        ),
      );
    }
    throw applyError;
  }

  private async prepareTransactionApply(
    transaction: InpaintingRevisionTransaction,
    direction: "undo" | "redo",
  ): Promise<Map<string, PreparedChapterRevision>> {
    const grouped = groupChangesByChapter(transaction.changes);
    const prepared = new Map<string, PreparedChapterRevision>();
    for (const [chapterId, changes] of grouped) {
      const chapter = await this.repository.readChapter(chapterId);
      const nextPages: MangaPage[] = [];
      const originalPages: MangaPage[] = [];
      const nextLayoutPatches: InpaintingPageLayoutPatch[] = [];
      const originalLayoutPatches: InpaintingPageLayoutPatch[] = [];
      for (const change of changes) {
        this.repository.validateChangePaths(chapter, change);
        const preparedPage = prepareInpaintingPageRevision({
          chapter,
          change,
          direction,
        });
        originalPages.push(preparedPage.originalPage);
        nextPages.push(preparedPage.nextPage);
        if (preparedPage.nextLayoutPatch) {
          nextLayoutPatches.push(preparedPage.nextLayoutPatch);
        }
        if (preparedPage.originalLayoutPatch) {
          originalLayoutPatches.push(preparedPage.originalLayoutPatch);
        }
      }
      prepared.set(chapterId, {
        nextPages,
        originalPages,
        nextLayoutPatches,
        originalLayoutPatches,
      });
    }
    return prepared;
  }

  private mutationOptionsForChapter(
    chapterId: string,
    layoutPatches: InpaintingPageLayoutPatch[] = [],
  ): InpaintingArtifactCleanupOptions {
    return {
      retainedInpaintedArtifactPaths: this.getRetainedArtifactPaths(chapterId),
      ...(layoutPatches.length > 0 ? { layoutPatches } : {}),
    };
  }

  private cleanupReleasedChanges(
    releasedChanges: InpaintingRevisionChange[],
  ): Promise<void> {
    const scheduled = this.cleanupTail.then(() =>
      this.runReleasedChangesCleanup(releasedChanges),
    );
    this.cleanupTail = scheduled.catch((error) => {
      this.diagnostics.warn(
        "Unexpected failure in inpainting history cleanup queue",
        { error },
      );
    });
    return scheduled;
  }

  private async runReleasedChangesCleanup(
    releasedChanges: InpaintingRevisionChange[],
  ): Promise<void> {
    const cleanupChanges = uniqueRevisionChanges([
      ...this.pendingCleanupChanges,
      ...releasedChanges,
    ]);
    this.pendingCleanupChanges = [];
    if (cleanupChanges.length === 0) return;

    const retryChanges: InpaintingRevisionChange[] = [];
    try {
      await this.repository.runMutation(async () => {
        for (const [chapterId, changes] of groupChangesByChapter(
          cleanupChanges,
        )) {
          try {
            await this.repository.cleanupReleasedArtifacts({
              chapterId,
              changes,
              retainedPaths: this.getRetainedArtifactPaths(chapterId),
            });
          } catch (error) {
            this.diagnostics.warn(
              "Failed to clean released inpainting history artifacts",
              { chapterId, error },
            );
            retryChanges.push(...changes);
          }
        }
      });
    } catch (error) {
      this.diagnostics.warn(
        "Failed to acquire library lock for inpainting history cleanup",
        { error },
      );
      retryChanges.push(...cleanupChanges);
    }
    this.pendingCleanupChanges = uniqueRevisionChanges([
      ...this.pendingCleanupChanges,
      ...retryChanges,
    ]);
  }
}
