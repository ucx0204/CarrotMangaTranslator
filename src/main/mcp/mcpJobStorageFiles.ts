import { lstat, mkdir, readFile, readdir, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertPathWithinRootWithoutSymlinks,
  writeDurableFile,
  durableRemoveFile,
} from "../libraryStore/libraryTransactionStorage";

/** Only app-private, generated relative paths enter this adapter. */
export class McpJobStorageFiles {
  constructor(readonly root: string) {}
  async ensure(relative: string) {
    await mkdir(await this.path(relative, true), {
      recursive: true,
      mode: 0o700,
    });
    await this.path(relative);
  }
  async path(relative: string, missing = false) {
    const path = join(this.root, relative);
    await assertPathWithinRootWithoutSymlinks(this.root, path, {
      allowMissingTarget: missing,
    });
    return path;
  }
  async read(relative: string, max: number): Promise<Buffer> {
    const path = await this.path(relative, true);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > max)
      throw new Error("Invalid or oversized MCP job file.");
    const bytes = await readFile(path);
    if (bytes.length > max) throw new Error("Oversized MCP job file.");
    return bytes;
  }
  async write(relative: string, bytes: Buffer, max: number) {
    if (bytes.length > max)
      throw new Error("MCP job file exceeds its capacity.");
    const path = await this.path(relative, true);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await this.path(relative, true);
    await writeDurableFile(path, bytes);
  }
  async list(relative: string): Promise<string[]> {
    try {
      const path = await this.path(relative, true);
      if (!(await lstat(path)).isDirectory())
        throw new Error("Invalid MCP job directory.");
      return (await readdir(path)).sort();
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }
  async remove(relative: string) {
    const path = await this.path(relative, true);
    if (!(await lstat(path)).isFile())
      throw new Error("Refusing non-file job cleanup.");
    await durableRemoveFile(path);
  }
  async empty(relative: string) {
    try {
      await rmdir(await this.path(relative, true));
    } catch (error) {
      if (
        !missing(error) &&
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOTEMPTY"
        )
      )
        throw error;
    }
  }
}
export function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
