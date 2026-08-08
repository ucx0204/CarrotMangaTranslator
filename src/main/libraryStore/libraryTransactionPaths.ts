/* eslint-disable complexity -- fail-closed transaction path validation is intentionally exhaustive for security auditability */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LibraryTransactionJournal } from "./libraryTransactionSchema";
import { isPathInside } from "./storage";

const MAX_TRANSACTION_PATH_LENGTH = 4096;
const MAX_TRANSACTION_PATH_SEGMENT_LENGTH = 255;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /^\\\\/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function validateCanonicalRelativePath(
  value: string,
  label = "transaction path",
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TRANSACTION_PATH_LENGTH ||
    value === "." ||
    value === ".." ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    WINDOWS_ABSOLUTE_PATH.test(value) ||
    WINDOWS_UNC_PATH.test(value) ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`${label}가 안전한 상대 경로가 아닙니다: ${value}`);
  }

  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.length > MAX_TRANSACTION_PATH_SEGMENT_LENGTH,
    )
  ) {
    throw new Error(`${label}가 안전한 상대 경로가 아닙니다: ${value}`);
  }
  return value;
}

export function toLibraryRelativePath(
  libraryRoot: string,
  targetPath: string,
): string {
  const resolvedRoot = resolve(libraryRoot);
  const resolvedTarget = resolve(targetPath);
  if (
    resolvedTarget === resolvedRoot ||
    !isPathInside(resolvedRoot, resolvedTarget)
  ) {
    throw new Error("transaction 대상이 보관함 root 밖을 가리킵니다.");
  }
  const nativeRelative = relative(resolvedRoot, resolvedTarget);
  const canonical = nativeRelative.split(sep).join("/");
  validateCanonicalRelativePath(canonical, "transaction target");
  if (canonical === ".transactions" || canonical.startsWith(".transactions/")) {
    throw new Error(
      "transaction 대상은 .transactions 내부를 가리킬 수 없습니다.",
    );
  }
  return canonical;
}

export function resolveLibraryRelativePath(
  libraryRoot: string,
  relativePath: string,
): string {
  const checked = validateCanonicalRelativePath(
    relativePath,
    "transaction target",
  );
  if (checked === ".transactions" || checked.startsWith(".transactions/")) {
    throw new Error(
      "transaction 대상은 .transactions 내부를 가리킬 수 없습니다.",
    );
  }
  const resolvedRoot = resolve(libraryRoot);
  const target = resolve(resolvedRoot, ...checked.split("/"));
  if (target === resolvedRoot || !isPathInside(resolvedRoot, target)) {
    throw new Error("transaction 대상이 보관함 root 밖을 가리킵니다.");
  }
  return target;
}

export function resolveTransactionRelativePath(
  transactionRoot: string,
  relativePath: string,
  expectedPrefix?: "staged" | "backups" | "trash",
): string {
  const checked = validateCanonicalRelativePath(
    relativePath,
    "transaction private path",
  );
  if (
    expectedPrefix &&
    checked !== expectedPrefix &&
    !checked.startsWith(`${expectedPrefix}/`)
  ) {
    throw new Error(
      `transaction private path가 ${expectedPrefix}/ 아래에 있지 않습니다.`,
    );
  }
  const resolvedRoot = resolve(transactionRoot);
  const target = resolve(resolvedRoot, ...checked.split("/"));
  if (target === resolvedRoot || !isPathInside(resolvedRoot, target)) {
    throw new Error(
      "transaction private path가 transaction root 밖을 가리킵니다.",
    );
  }
  return target;
}

export function validateLibraryTransactionJournalPaths(
  journal: LibraryTransactionJournal,
): void {
  const targets: string[] = [];
  const privatePaths = new Set<string>();

  for (const step of journal.steps) {
    const target = validateCanonicalRelativePath(
      step.target,
      "transaction target",
    );
    if (target === ".transactions" || target.startsWith(".transactions/")) {
      throw new Error(
        "transaction 대상은 .transactions 내부를 가리킬 수 없습니다.",
      );
    }
    for (const existing of targets) {
      if (
        existing === target ||
        existing.startsWith(`${target}/`) ||
        target.startsWith(`${existing}/`)
      ) {
        throw new Error(
          `transaction target이 중복되거나 서로 겹칩니다: ${existing}, ${target}`,
        );
      }
    }
    targets.push(target);

    const registerPrivatePath = (
      value: string | undefined,
      prefix: "staged" | "backups" | "trash",
    ): void => {
      if (!value) {
        return;
      }
      const checked = validateCanonicalRelativePath(
        value,
        "transaction private path",
      );
      if (checked !== prefix && !checked.startsWith(`${prefix}/`)) {
        throw new Error(
          `transaction private path가 ${prefix}/ 아래에 있지 않습니다.`,
        );
      }
      if (privatePaths.has(checked)) {
        throw new Error(`transaction private path가 중복됩니다: ${checked}`);
      }
      privatePaths.add(checked);
    };

    if (step.kind === "replace-file") {
      if (step.hadOriginal && (!step.backup || !step.backupSha256)) {
        throw new Error(
          "원본 replace step에는 backup과 backup hash가 필요합니다.",
        );
      }
      if (!step.hadOriginal && (step.backup || step.backupSha256)) {
        throw new Error("새 replace step에는 backup metadata가 없어야 합니다.");
      }
      registerPrivatePath(step.staged, "staged");
      registerPrivatePath(step.backup, "backups");
    } else if (step.kind === "publish-directory") {
      registerPrivatePath(step.staged, "staged");
      const marker = validateCanonicalRelativePath(
        step.ownerMarker,
        "transaction owner marker",
      );
      if (!marker.startsWith(`${step.staged}/`)) {
        throw new Error(
          "owner marker가 publish staging directory 밖을 가리킵니다.",
        );
      }
      if (privatePaths.has(marker)) {
        throw new Error(`transaction private path가 중복됩니다: ${marker}`);
      }
      privatePaths.add(marker);
    } else {
      registerPrivatePath(step.trash, "trash");
    }
  }
}

export function assertNoTargetOverlap(
  existingTargets: string[],
  target: string,
): void {
  for (const existing of existingTargets) {
    if (
      existing === target ||
      existing.startsWith(`${target}/`) ||
      target.startsWith(`${existing}/`)
    ) {
      throw new Error(
        `transaction target이 중복되거나 서로 겹칩니다: ${existing}, ${target}`,
      );
    }
  }
}
