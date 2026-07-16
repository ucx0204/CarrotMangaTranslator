import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// TypeScript compiles dynamic import to require() for this CommonJS main process.
// Keep the native import escape hatch isolated so ESM-only packages can still be
// loaded without spreading new Function usage through the codebase.
const nativeDynamicImport = new Function(
  "specifier",
  "return import(specifier)",
) as <T>(specifier: string) => Promise<T>;

export const OPENAI_OAUTH_RUNTIME_RELATIVE_PATH = join(
  "app-runtime",
  "openai-oauth-runtime.mjs",
);

export function importNativeEsm<T>(specifier: string): Promise<T> {
  assertAllowedNativeImport(specifier);
  return nativeDynamicImport<T>(specifier);
}

export function assertAllowedNativeImport(
  specifier: string,
  resourcesPath = resolveProcessResourcesPath(),
): void {
  if (specifier === "openai-oauth") {
    return;
  }

  const normalized = normalizeImportSpecifier(specifier);
  const bundledRuntimePath = resourcesPath
    ? join(resourcesPath, OPENAI_OAUTH_RUNTIME_RELATIVE_PATH)
    : null;
  if (
    normalized &&
    (/(^|[\\/])openai-oauth[\\/]dist[\\/]index\.js$/i.test(normalized) ||
      (bundledRuntimePath !== null &&
        normalizePathForComparison(normalized) ===
          normalizePathForComparison(bundledRuntimePath)))
  ) {
    return;
  }

  throw new Error(`허용되지 않은 동적 모듈 import입니다: ${specifier}`);
}

function normalizeImportSpecifier(specifier: string): string | null {
  if (specifier.startsWith("file:")) {
    try {
      return fileURLToPath(specifier);
    } catch (_error) {
      return null;
    }
  }
  return specifier;
}

function resolveProcessResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

function normalizePathForComparison(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
