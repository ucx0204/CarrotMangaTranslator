import {
  copyFileAtomically,
  writeBinaryFileAtomically,
  resolvePathInside,
} from "./linkedWorkspacePaths";
import {
  unlinkIfExists,
  type AtomicFilePublication,
} from "../libraryStore/storage";
import { reviewedPathKey } from "./linkedWorkspaceReviewedOutputEvidence";
import {
  createReviewedPublicationHooks,
  reviewedPublicationLimit,
} from "./linkedWorkspaceReviewedOutputHooks";
import { verifyReviewedOutput } from "./linkedWorkspaceReviewedOutputVerify";
import {
  REVIEWED_OUTPUT_LIMITS,
  ReviewedOutputError,
  type ReviewedOutputDigest,
  type ReviewedOutputExecution,
  type ReviewedOutputFileOutcome,
  type ReviewedOutputResult,
} from "./linkedWorkspaceReviewedOutputTypes";
import type {
  NativeLinkedOutputOwner,
  ReviewedNativePlan,
  ReviewedNativeState,
  ReviewedNativeFile,
} from "./linkedWorkspaceReviewedOutputInternal";

export class ReviewedOutputPublisher {
  readonly state: ReviewedNativeState;
  readonly outcomes = new Map<string, ReviewedOutputFileOutcome>();
  publishedBytes = 0;
  private reservedBytes = 0;
  private registryCount = 0;

  constructor(
    readonly owner: NativeLinkedOutputOwner,
    readonly plan: ReviewedNativePlan,
    readonly context: ReviewedOutputExecution,
  ) {
    this.state = {
      records: structuredClone(plan.records),
      targets: new Map(plan.targets),
    };
    for (const file of plan.files) this.add(file);
  }

  guard = () => {
    this.context.signal.throwIfAborted();
    this.context.assertAuthorized();
  };

  async verify(pageId: string | null = null, relativePath?: string) {
    await verifyReviewedOutput(
      this.owner,
      this.plan,
      this.state,
      this.guard,
      pageId,
      relativePath,
    );
  }

  async publish(file: ReviewedNativeFile, content?: Buffer) {
    if (!file.relativePath) throw new ReviewedOutputError("unsafe_path");
    const path = resolvePathInside(this.plan.rootPath, file.relativePath);
    try {
      if (file.action === "remove") return await this.remove(file, path);
      const hooks = this.hooks(file);
      if (file.sourcePath)
        await copyFileAtomically(file.sourcePath, path, undefined, hooks);
      else {
        if (!content) throw new ReviewedOutputError("publication_failed");
        if (content.byteLength > REVIEWED_OUTPUT_LIMITS.imageBytes)
          throw new ReviewedOutputError("limit_exceeded");
        await writeBinaryFileAtomically(path, content, undefined, hooks);
      }
    } catch (error) {
      this.failed(file);
      throw error;
    }
  }

  registryFile(): ReviewedNativeFile {
    if (this.registryCount >= this.plan.pages.length + 1)
      throw new ReviewedOutputError("limit_exceeded");
    const file: ReviewedNativeFile = {
      fileId: "registry:" + this.registryCount++ + ":publish",
      role: "registry",
      pageId: null,
      action: "publish",
      previous: null,
      desired: null,
      relativePath: null,
      sourcePath: null,
    };
    this.add(file);
    return file;
  }

  hooks(
    file: ReviewedNativeFile,
    nativeCommit?: () => void,
  ): AtomicFilePublication {
    return createReviewedPublicationHooks(file, {
      rootPath: this.plan.rootPath,
      dataRoot: this.owner.dataRoot,
      signal: this.context.signal,
      guard: this.guard,
      verify: () => this.verify(file.pageId, file.relativePath ?? undefined),
      admit: (digest) => this.intent(file, digest),
      attempted: () => {
        this.require(file).state = "publication_unconfirmed";
      },
      committed: async (digest, target) => {
        if (file.relativePath)
          this.state.targets.set(reviewedPathKey(target), digest);
        nativeCommit?.();
        await this.effect(file, digest);
      },
    });
  }

  result(error?: unknown): ReviewedOutputResult {
    const files = [...this.outcomes.values()];
    const uncertain = files.some(
      (file) => file.state === "publication_unconfirmed",
    );
    const recorded = files.some(
      (file) => file.state === "published" || file.state === "removed",
    );
    return {
      status: error
        ? this.context.signal.aborted
          ? "cancelled"
          : recorded || uncertain
            ? "partial"
            : "failed"
        : "completed",
      errorCode:
        error instanceof ReviewedOutputError
          ? error.code
          : error
            ? "publication_failed"
            : null,
      files,
      publishedBytes: this.publishedBytes,
      metadata: metadataState(files, this.plan.pages.length + 1),
      mirror: mirrorState(files),
    };
  }

  private add(file: ReviewedNativeFile) {
    this.outcomes.set(file.fileId, {
      fileId: file.fileId,
      role: file.role,
      pageId: file.pageId,
      action: file.action,
      previous: file.previous,
      state: "planned",
      bytes: null,
      sha256: null,
      completedAt: null,
    });
  }

  private require(file: ReviewedNativeFile) {
    const outcome = this.outcomes.get(file.fileId);
    if (!outcome) throw new ReviewedOutputError("publication_failed");
    return outcome;
  }

  private async intent(
    file: ReviewedNativeFile,
    desired: ReviewedOutputDigest | null,
  ) {
    this.guard();
    const bytes = desired?.bytes ?? 0;
    const cap = reviewedPublicationLimit(file);
    if (
      bytes > cap ||
      this.reservedBytes + bytes > REVIEWED_OUTPUT_LIMITS.publishedBytes
    )
      throw new ReviewedOutputError("limit_exceeded");
    const outcome = this.require(file);
    outcome.previous = file.previous;
    try {
      await this.context.onIntent(
        structuredClone({
          fileId: file.fileId,
          role: file.role,
          pageId: file.pageId,
          action: file.action,
          previous: file.previous,
          relativePath: file.relativePath,
          desired,
        }),
      );
    } catch (error) {
      throw new ReviewedOutputError("receipt_failed", { cause: error });
    }
    file.desired = desired;
    this.reservedBytes += bytes;
  }

  private async effect(
    file: ReviewedNativeFile,
    digest: ReviewedOutputDigest | null,
  ) {
    const completedAt = Date.now();
    const state = file.action === "remove" ? "removed" : "published";
    const bytes = digest?.bytes ?? 0;
    this.publishedBytes += bytes;
    try {
      await this.context.onEffect({
        fileId: file.fileId,
        state,
        bytes,
        sha256: digest?.sha256 ?? null,
        completedAt,
      });
    } catch (error) {
      throw new ReviewedOutputError("receipt_failed", { cause: error });
    }
    Object.assign(this.require(file), {
      state,
      bytes,
      sha256: digest?.sha256 ?? null,
      completedAt,
    });
  }

  private async remove(file: ReviewedNativeFile, path: string) {
    await this.verify(file.pageId, file.relativePath ?? undefined);
    await this.intent(file, null);
    await this.verify(file.pageId, file.relativePath ?? undefined);
    this.guard();
    this.require(file).state = "publication_unconfirmed";
    await unlinkIfExists(path);
    this.state.targets.set(reviewedPathKey(path), null);
    await this.effect(file, null);
  }

  private failed(file: ReviewedNativeFile) {
    const outcome = this.require(file);
    if (outcome.state === "planned") outcome.state = "failed";
  }
}

function metadataState(
  files: ReviewedOutputFileOutcome[],
  expected: number,
): ReviewedOutputResult["metadata"] {
  const registry = files.filter((file) => file.role === "registry");
  if (registry.some((file) => file.state === "publication_unconfirmed"))
    return "publication_unconfirmed";
  if (
    registry.length === expected &&
    registry.every((file) => file.state === "published")
  )
    return "published";
  return registry.some((file) => file.state === "published")
    ? "partial"
    : "pending";
}

function mirrorState(
  files: ReviewedOutputFileOutcome[],
): ReviewedOutputResult["mirror"] {
  const state = files.find((file) => file.role === "mirror")?.state;
  return state === "published" || state === "publication_unconfirmed"
    ? state
    : "pending";
}
