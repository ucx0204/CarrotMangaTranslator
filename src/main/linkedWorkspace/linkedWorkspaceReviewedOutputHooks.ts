import { join } from "node:path";
import type { AtomicFilePublication } from "../libraryStore/storage";
import { resolvePathInside } from "./linkedWorkspacePaths";
import {
  assertReviewedPath,
  readReviewedFile,
  assertReviewedDigest,
} from "./linkedWorkspaceReviewedOutputEvidence";
import {
  REVIEWED_OUTPUT_LIMITS,
  ReviewedOutputError,
  type ReviewedOutputDigest,
} from "./linkedWorkspaceReviewedOutputTypes";
import type { ReviewedNativeFile } from "./linkedWorkspaceReviewedOutputInternal";

type HookOwner = {
  rootPath: string;
  dataRoot: string;
  signal: AbortSignal;
  guard: () => void;
  verify: () => Promise<void>;
  admit: (digest: ReviewedOutputDigest) => Promise<void>;
  attempted: () => void;
  committed: (digest: ReviewedOutputDigest, target: string) => Promise<void>;
};
type PreparedFile = {
  temporary: string | null;
  digest: ReviewedOutputDigest | null;
};

export function reviewedPublicationLimit(file: ReviewedNativeFile) {
  return file.role === "mirror" || file.role === "registry"
    ? REVIEWED_OUTPUT_LIMITS.mirrorBytes
    : REVIEWED_OUTPUT_LIMITS.imageBytes;
}

export function createReviewedPublicationHooks(
  file: ReviewedNativeFile,
  owner: HookOwner,
): AtomicFilePublication {
  const target = file.relativePath
    ? resolvePathInside(owner.rootPath, file.relativePath)
    : join(owner.dataRoot, "linked-workspaces.json");
  const root = file.role === "registry" ? owner.dataRoot : owner.rootPath;
  const prepared: PreparedFile = { temporary: null, digest: null };
  return {
    signal: owner.signal,
    beforePrepare: async (temporary, actual) => {
      owner.guard();
      if (actual !== target) throw new ReviewedOutputError("unsafe_path");
      await assertReviewedPath(root, actual);
      await assertReviewedPath(root, temporary);
    },
    prepared: async (temporary) => {
      prepared.temporary = temporary;
      prepared.digest = await readReviewedFile(
        temporary,
        false,
        reviewedPublicationLimit(file),
      );
      if (!prepared.digest) throw new ReviewedOutputError("publication_failed");
      if (file.desired) assertReviewedDigest(prepared.digest, file.desired);
      if (file.role === "registry")
        file.previous = await readReviewedFile(
          target,
          true,
          reviewedPublicationLimit(file),
        );
      await owner.admit(prepared.digest);
    },
    beforeAttempt: () =>
      verifyPreparedFile(file, owner, prepared, root, target),
    committed: async () => {
      if (!prepared.digest) throw new ReviewedOutputError("publication_failed");
      await owner.committed(prepared.digest, target);
    },
  };
}

async function verifyPreparedFile(
  file: ReviewedNativeFile,
  owner: HookOwner,
  prepared: PreparedFile,
  root: string,
  target: string,
) {
  await owner.verify();
  await assertReviewedPath(root, target);
  if (!prepared.temporary) throw new ReviewedOutputError("publication_failed");
  await assertReviewedPath(root, prepared.temporary);
  assertReviewedDigest(
    await readReviewedFile(
      prepared.temporary,
      false,
      reviewedPublicationLimit(file),
    ),
    prepared.digest,
  );
  assertReviewedDigest(
    await readReviewedFile(target, true, reviewedPublicationLimit(file)),
    file.previous,
  );
  owner.guard();
  owner.attempted();
}
