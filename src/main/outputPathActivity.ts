import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AppActivityResource } from "../shared/appActivityTypes";

export async function outputPathResource(
  path: string,
  directory = false,
): Promise<AppActivityResource> {
  const canonical = directory
    ? await canonicalPath(path)
    : resolve(await canonicalPath(dirname(path)), basename(path));
  const normalized = (
    process.platform === "win32" ? canonical.toLowerCase() : canonical
  ).replaceAll("\\", "/");
  return {
    kind: "output-path",
    scope: directory ? `${normalized}/**` : normalized,
    access: "write",
  };
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    const absolute = resolve(path);
    const parent = dirname(absolute);
    return parent === absolute
      ? absolute
      : resolve(await canonicalPath(parent), basename(absolute));
  }
}
