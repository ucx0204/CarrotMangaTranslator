import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { safeStorage } from "electron";
import { z } from "zod";
import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import {
  assertPathWithinRootWithoutSymlinks,
  writeDurableFile,
} from "../libraryStore/libraryTransactionStorage";
import {
  parseMcpOAuthSnapshot,
  type McpOAuthSnapshot,
} from "./mcpOAuthSnapshot";

export type McpEncryptionPort = {
  available: () => boolean;
  encrypt: (text: string) => Buffer;
  decrypt: (bytes: Buffer) => string;
};
const osEncryption: McpEncryptionPort = {
  available: () =>
    safeStorage.isEncryptionAvailable() &&
    !(
      process.platform === "linux" &&
      safeStorage.getSelectedStorageBackend() === "basic_text"
    ),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (bytes) => safeStorage.decryptString(bytes),
};
const preferencesSchema = z
  .object({
    allowImages: z.boolean(),
    allowEditing: z.boolean(),
    autoStart: z.boolean(),
  })
  .strict();
const secretSchema = z
  .object({
    version: z.literal(1),
    localToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    oauth: z.unknown().optional(),
  })
  .strict();
type Secrets = { version: 1; localToken: string; oauth?: McpOAuthSnapshot };

/** Separate app-private state; this never reads/writes manga library records.
 * Reuses the existing fsync/atomic-rename adapter, not a second storage protocol. */
export class McpSecureStore {
  private readonly directory: string;
  private current?: Secrets;
  private loading?: Promise<Secrets>;
  constructor(
    private readonly dataRoot: string,
    private readonly encryption = osEncryption,
  ) {
    this.directory = join(dataRoot, "mcp-private");
  }
  load(): Promise<Secrets> {
    this.loading ??= this.readSecrets();
    return this.loading;
  }
  async saveAuthorization(oauth: McpOAuthSnapshot): Promise<void> {
    const current = await this.load();
    const checked = parseMcpOAuthSnapshot(
      oauth,
      current.oauth?.issuer ?? oauth.issuer,
    );
    const next: Secrets = { ...current, oauth: checked };
    await this.writeSecrets(next);
    this.current = next;
    this.loading = Promise.resolve(next);
  }
  async preferences(): Promise<McpPreferences> {
    const text = await this.read("settings.json");
    return text === null
      ? { allowImages: false, allowEditing: false, autoStart: false }
      : preferencesSchema.parse(JSON.parse(text));
  }
  async savePreferences(value: McpPreferences): Promise<void> {
    await this.write(
      "settings.json",
      Buffer.from(JSON.stringify(preferencesSchema.parse(value))),
    );
  }
  private async readSecrets(): Promise<Secrets> {
    if (!this.encryption.available())
      throw new Error(
        "OS-backed MCP encryption is unavailable. No plaintext credentials will be stored.",
      );
    const text = await this.read("authorization.enc");
    if (text === null) {
      const fresh: Secrets = {
        version: 1,
        localToken: randomBytes(32).toString("base64url"),
      };
      await this.writeSecrets(fresh);
      this.current = fresh;
      return fresh;
    }
    const parsed = secretSchema.parse(
      JSON.parse(this.encryption.decrypt(Buffer.from(text, "base64"))),
    );
    const oauth =
      parsed.oauth === undefined
        ? undefined
        : parseSavedAuthorization(parsed.oauth);
    this.current = { version: 1, localToken: parsed.localToken, oauth };
    return this.current;
  }
  private async writeSecrets(value: Secrets): Promise<void> {
    if (!this.encryption.available())
      throw new Error("OS-backed MCP encryption is unavailable.");
    await this.write(
      "authorization.enc",
      Buffer.from(
        this.encryption.encrypt(JSON.stringify(value)).toString("base64"),
      ),
    );
  }
  private async safePath(name: string): Promise<string> {
    const path = join(this.directory, name);
    await assertPathWithinRootWithoutSymlinks(this.dataRoot, path, {
      allowMissingTarget: true,
    });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await assertPathWithinRootWithoutSymlinks(this.dataRoot, path, {
      allowMissingTarget: true,
    });
    return path;
  }
  private async read(name: string): Promise<string | null> {
    const path = await this.safePath(name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > 8 * 1024 * 1024)
        throw new Error("Invalid or oversized MCP state file.");
      return await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  private async write(name: string, bytes: Buffer): Promise<void> {
    if (bytes.length > 8 * 1024 * 1024)
      throw new Error("MCP authorization storage capacity reached.");
    await writeDurableFile(await this.safePath(name), bytes);
  }
}
function isMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
function parseSavedAuthorization(value: unknown): McpOAuthSnapshot {
  const identity = z.object({ issuer: z.string() }).passthrough().parse(value);
  return parseMcpOAuthSnapshot(value, identity.issuer);
}
