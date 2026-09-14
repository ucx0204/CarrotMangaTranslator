import { resolve } from "node:path";

const references = new Map<string, number>();
const keyFor = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

export function retainLibraryArtifacts(paths: readonly string[]): () => void {
  const keys = new Set(paths.map(keyFor));
  for (const key of keys) references.set(key, (references.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const count = (references.get(key) ?? 1) - 1;
      if (count > 0) references.set(key, count);
      else references.delete(key);
    }
  };
}

export function isLibraryArtifactRetained(path: string): boolean {
  return references.has(keyFor(path));
}
