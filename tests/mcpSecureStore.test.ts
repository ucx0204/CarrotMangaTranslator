import assert from "node:assert/strict";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it, vi } from "vitest";
import { McpSecureStore } from "../src/main/mcp/mcpSecureStore";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false }, app: { isPackaged: false } }));
const roots: string[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), "carrot-mcp-store-")); roots.push(value); return value; }
afterEach(async () => { for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true }); });
function codec() {
  const key = randomBytes(32);
  return {
    available: () => true,
    encrypt: (text: string) => {
      const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
      const payload = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), payload]);
    },
    decrypt: (bytes: Buffer) => {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}
it("writes encrypted credentials atomically and restores the same identity with a fresh store", async () => {
  const directory = await root(); const encryption = codec();
  const first = new McpSecureStore(directory, encryption);
  const identity = await first.load();
  const contents = await readFile(join(directory, "mcp-private/authorization.enc"), "utf8");
  assert.equal(contents.includes(identity.localToken), false);
  assert.equal(Buffer.from(contents, "base64").includes(Buffer.from(identity.localToken)), false);
  const provider = new McpOAuthProvider("https://carrot.tail-test.ts.net", "p".repeat(43), Date.now, { persistent: true });
  await first.saveAuthorization(provider.snapshot());
  const restored = await new McpSecureStore(directory, encryption).load();
  assert.equal(restored.localToken, identity.localToken);
  assert.deepEqual(restored.oauth, provider.snapshot());
  assert.equal((await first.preferences()).autoStart, false);
  await first.savePreferences({ allowImages: true, allowEditing: false, autoStart: true });
  assert.equal((await new McpSecureStore(directory, encryption).preferences()).allowImages, true);
});
it("never silently replaces corrupt credentials or falls back to plaintext", async () => {
  const directory = await root(); const encryption = codec();
  await new McpSecureStore(directory, encryption).load();
  const path = join(directory, "mcp-private/authorization.enc");
  await writeFile(path, "corrupt");
  await assert.rejects(new McpSecureStore(directory, encryption).load());
  assert.equal(await readFile(path, "utf8"), "corrupt");
  await assert.rejects(new McpSecureStore(await root(), { ...encryption, available: () => false }).load(), /No plaintext/);
});
it("refuses symlinked private state without touching its external target", async () => {
  const directory = await root(); const external = await root();
  await mkdir(join(directory, "mcp-private"));
  const target = join(external, "do-not-touch"); await writeFile(target, "preserve");
  await symlink(target, join(directory, "mcp-private/authorization.enc"));
  await assert.rejects(new McpSecureStore(directory, codec()).load());
  assert.equal(await readFile(target, "utf8"), "preserve");
});
