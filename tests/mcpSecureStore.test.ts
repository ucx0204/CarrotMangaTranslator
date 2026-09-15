import assert from "node:assert/strict";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it, vi } from "vitest";
import { McpSecureStore } from "../src/main/mcp/mcpSecureStore";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
vi.mock("electron", () => ({
  safeStorage: { isEncryptionAvailable: () => false },
  app: { isPackaged: false },
}));
const roots: string[] = [];
async function root() {
  const value = await mkdtemp(join(tmpdir(), "carrot-mcp-store-"));
  roots.push(value);
  return value;
}
afterEach(async () => {
  for (const value of roots.splice(0))
    await rm(value, { recursive: true, force: true });
});
function codec() {
  const key = randomBytes(32);
  return {
    available: () => true,
    encrypt: (text: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const payload = Buffer.concat([
        cipher.update(text, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), payload]);
    },
    decrypt: (bytes: Buffer) => {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
it("writes encrypted credentials atomically and restores the same identity with a fresh store", async () => {
  const directory = await root();
  const encryption = codec();
  const first = new McpSecureStore(directory, encryption);
  const identity = await first.load();
  const contents = await readFile(
    join(directory, "mcp-private/authorization.enc"),
    "utf8",
  );
  assert.equal(contents.includes(identity.localToken), false);
  assert.equal(
    Buffer.from(contents, "base64").includes(Buffer.from(identity.localToken)),
    false,
  );
  const provider = new McpOAuthProvider(
    "https://carrot.tail-test.ts.net",
    "p".repeat(43),
    Date.now,
    { persistent: true },
  );
  await first.saveAuthorization(provider.snapshot());
  const restored = await new McpSecureStore(directory, encryption).load();
  assert.equal(restored.localToken, identity.localToken);
  assert.deepEqual(restored.oauth, provider.snapshot());
  assert.deepEqual(await first.preferences(), {
    allowImages: true,
    allowEditing: true,
    allowProcessing: true,
    autoStart: true,
  });
  await first.savePreferences({
    allowImages: true,
    allowEditing: false,
    autoStart: true,
  });
  assert.equal(
    (await new McpSecureStore(directory, encryption).preferences()).allowImages,
    true,
  );
});
it("never silently replaces corrupt credentials or falls back to plaintext", async () => {
  const directory = await root();
  const encryption = codec();
  await new McpSecureStore(directory, encryption).load();
  const path = join(directory, "mcp-private/authorization.enc");
  await writeFile(path, "corrupt");
  await assert.rejects(new McpSecureStore(directory, encryption).load());
  assert.equal(await readFile(path, "utf8"), "corrupt");
  await assert.rejects(
    new McpSecureStore(await root(), {
      ...encryption,
      available: () => false,
    }).load(),
    /No plaintext/,
  );
});
it("refuses symlinked private state without touching its external target", async () => {
  const directory = await root();
  const external = await root();
  await mkdir(join(directory, "mcp-private"));
  const target = join(external, "do-not-touch");
  await writeFile(target, "preserve");
  await symlink(target, join(directory, "mcp-private/authorization.enc"));
  await assert.rejects(new McpSecureStore(directory, codec()).load());
  assert.equal(await readFile(target, "utf8"), "preserve");
});

it("can retry a temporarily unavailable key store without a plaintext fallback", async () => {
  const directory = await root();
  const encryption = codec();
  let available = false;
  const store = new McpSecureStore(directory, {
    ...encryption,
    available: () => available,
  });
  await assert.rejects(store.load(), /encryption is unavailable/);
  await assert.rejects(
    readFile(join(directory, "mcp-private/authorization.enc")),
    { code: "ENOENT" },
  );
  available = true;
  const restored = await store.load();
  assert.equal(restored.localToken.length, 43);
  assert.equal(
    (
      await readFile(join(directory, "mcp-private/authorization.enc"), "utf8")
    ).includes(restored.localToken),
    false,
  );
});

it("preserves saved opt-outs and legacy processing choices instead of replacing them with new defaults", async () => {
  const directory = await root();
  const store = new McpSecureStore(directory, codec());
  const disabled = {
    allowImages: false,
    allowEditing: false,
    autoStart: false,
  };
  await store.savePreferences(disabled);
  assert.deepEqual(
    await new McpSecureStore(directory, codec()).preferences(),
    disabled,
  );
  const explicit = { ...disabled, allowProcessing: false };
  await store.savePreferences(explicit);
  assert.deepEqual(
    await new McpSecureStore(directory, codec()).preferences(),
    explicit,
  );
});
it("returns fresh checked defaults without initializing authorization or sharing mutable preference objects", async () => {
  const directory = await root();
  const encryption = { ...codec(), available: () => false };
  const store = new McpSecureStore(directory, encryption);
  const first = await store.preferences();
  assert.equal(
    Object.values(first).every((value) => value === true),
    true,
  );
  first.allowImages = false;
  assert.equal((await store.preferences()).allowImages, true);
  await assert.rejects(
    readFile(join(directory, "mcp-private/authorization.enc")),
    { code: "ENOENT" },
  );
});

it("distinguishes new data profiles while preserving the same authority across restart", async () => {
  const directory = await root();
  const encryption = codec();
  const first = new McpSecureStore(directory, encryption);
  const identity = await first.identity();
  const restarted = await new McpSecureStore(directory, encryption).identity();
  assert.deepEqual(restarted, identity);
  const other = await new McpSecureStore(await root(), encryption).identity();
  assert.notEqual(other.serverId, identity.serverId);
  assert.notEqual(other.dataProfileId, identity.dataProfileId);
  const serialized = JSON.stringify(identity);
  assert.equal(serialized.includes(directory), false);
  assert.equal(serialized.includes((await first.load()).localToken), false);
});

it("encrypts the job journal, restores it, and refuses a copied journal in another data profile", async () => {
  const directory = await root();
  const encryption = codec();
  const store = new McpSecureStore(directory, encryption);
  const snapshot = {
    version: 1,
    records: [],
    marker: "never-plaintext-job-data",
  };
  assert.equal(await store.readJobJournal(), null);
  await store.writeJobJournal(snapshot);
  const bytes = await readFile(join(directory, "mcp-private/jobs.enc"));
  assert.equal(bytes.includes(Buffer.from(snapshot.marker)), false);
  const restarted = new McpSecureStore(directory, encryption);
  assert.deepEqual(await restarted.readJobJournal(), snapshot);
  const otherDirectory = await root();
  const other = new McpSecureStore(otherDirectory, encryption);
  await other.load();
  await writeFile(join(otherDirectory, "mcp-private/jobs.enc"), bytes);
  await assert.rejects(other.readJobJournal(), /different data profile/);
  assert.deepEqual(
    await readFile(join(otherDirectory, "mcp-private/jobs.enc")),
    bytes,
  );
  await assert.rejects(
    new McpSecureStore(directory, {
      ...encryption,
      available: () => false,
    }).readJobJournal(),
    /encryption/,
  );
  await assert.rejects(
    new McpSecureStore(directory, {
      ...encryption,
      available: () => false,
    }).writeJobJournal(snapshot),
    /encryption/,
  );
  await writeFile(join(directory, "mcp-private/jobs.enc"), "corrupt");
  await assert.rejects(restarted.readJobJournal());
  assert.equal(
    await readFile(join(directory, "mcp-private/jobs.enc"), "utf8"),
    "corrupt",
  );
});

it("refuses symlinked job journal reads and writes without touching their target", async () => {
  const directory = await root();
  const store = new McpSecureStore(directory, codec());
  await store.load();
  const external = join(await root(), "keep");
  await writeFile(external, "preserve");
  await symlink(external, join(directory, "mcp-private/jobs.enc"));
  await assert.rejects(store.readJobJournal());
  await assert.rejects(store.writeJobJournal({ version: 1, records: [] }));
  assert.equal(await readFile(external, "utf8"), "preserve");
});
