import { fileURLToPath } from "node:url";

// TypeScript compiles dynamic import to require() for this CommonJS main process.
// Keep the native import escape hatch isolated so ESM-only packages can still be
// loaded without spreading new Function usage through the codebase.
// eslint-disable-next-line no-new-func
const nativeDynamicImport = new Function("specifier", "return import(specifier)") as <T>(specifier: string) => Promise<T>;

export function importNativeEsm<T>(specifier: string): Promise<T> {
  assertAllowedNativeImport(specifier);
  return nativeDynamicImport<T>(specifier);
}

function assertAllowedNativeImport(specifier: string): void {
  if (specifier === "openai-oauth") {
    return;
  }

  const normalized = normalizeImportSpecifier(specifier);
  if (
    normalized &&
    /(^|[\\/])openai-oauth[\\/]dist[\\/]index\.js$/i.test(normalized)
  ) {
    return;
  }

  throw new Error(`허용되지 않은 동적 모듈 import입니다: ${specifier}`);
}

function normalizeImportSpecifier(specifier: string): string | null {
  if (specifier.startsWith("file:")) {
    try {
      return fileURLToPath(specifier);
    } catch {
      return null;
    }
  }
  return specifier;
}
