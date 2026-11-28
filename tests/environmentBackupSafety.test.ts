import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertFreeSpace,
  hashBackupFile,
} from "../src/main/environmentBackup/files";
import {
  extractBackupArchive,
  writeBackupArchive,
} from "../src/main/environmentBackup/archive";
import type { BackupManifest } from "../src/main/environmentBackup/policy";
import {
  suspendEnvironmentAccess,
  trackEnvironmentAccess,
} from "../src/main/environmentBackup/access";
import { portableSettings } from "../src/main/environmentBackup/settings";
import { resolveDefaultAppSettings } from "../src/main/appSettings";

const disk = vi.hoisted(() => ({ available: Number.MAX_SAFE_INTEGER }));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  statfs: async () => ({ bavail: disk.available, bsize: 1 }),
}));
vi.mock("electron", () => ({ app: { isPackaged: false } }));
const dirs: string[] = [];
afterEach(async () => {
  disk.available = Number.MAX_SAFE_INTEGER;
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "carrot-backup-safety-"));
  dirs.push(root);
  return root;
}
const signal = () => new AbortController().signal;
const progress = () => undefined;
async function archiveFixture() {
  const root = await temp();
  await writeFile(join(root, "portable-settings.json"), "{}");
  const file = await hashBackupFile(root, "portable-settings.json", signal());
  const manifest: BackupManifest = {
    format: "carrot-environment-backup",
    version: 1,
    appVersion: "2.8.0",
    createdAt: new Date().toISOString(),
    summary: { works: 0, pages: 0, bytes: file.size },
    files: [file],
    ui: {},
    connections: [],
  };
  return { root, manifest, archive: join(root, "test.zip") };
}
describe("backup safety", () => {
  it("extracts only verified library entries when a declared image size is wrong", async () => {
    const { root, manifest, archive } = await archiveFixture();
    const parent = "library/works/old";
    const image = parent + "/page.png",
      guide = parent + "/style-guide.json";
    await mkdir(join(root, parent), { recursive: true });
    await writeFile(join(root, image), "incomplete");
    await writeFile(join(root, guide), '{"glossary":[]}');
    const bad = await hashBackupFile(root, image, signal());
    manifest.files.push(
      { ...bad, size: bad.size + 1 },
      await hashBackupFile(root, guide, signal()),
    );
    manifest.summary.bytes = manifest.files.reduce(
      (sum, file) => sum + file.size,
      0,
    );
    // The production writer rejects size mismatches, so construct the damaged input directly.
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
    for (const file of manifest.files)
      zip.addFile(file.path, await readFile(join(root, file.path)));
    await writeFile(archive, zip.toBuffer());
    const dest = await temp(),
      report = vi.fn();
    const recovered = await extractBackupArchive({
      root: dest,
      archive,
      signal: signal(),
      progress,
      onDamagedFile: report,
    });
    expect(recovered.files.map((file) => file.path)).toEqual([guide]);
    expect(report).toHaveBeenCalledWith(image);
    expect(await readdir(join(dest, parent))).toEqual(["style-guide.json"]);
    expect(await readdir(dest)).toEqual(["library"]);
  });
  it("rejects checksum damage without accepting any restored environment", async () => {
    const { root, manifest, archive } = await archiveFixture();
    manifest.files[0].sha256 = "a".repeat(64);
    await writeBackupArchive(root, archive, manifest, signal(), progress);
    const target = await temp();
    await expect(
      extractBackupArchive({
        root: target,
        archive,
        signal: signal(),
        progress,
      }),
    ).rejects.toThrow("checksum");
  });
  it("rejects unsupported manifest versions", async () => {
    const { root, manifest, archive } = await archiveFixture();
    Object.assign(manifest, { version: 200 });
    await writeBackupArchive(root, archive, manifest, signal(), progress);
    await expect(
      extractBackupArchive({
        root: await temp(),
        archive,
        signal: signal(),
        progress,
      }),
    ).rejects.toThrow();
  });
  it("writes a ZIP64 archive and streams a multi-megabyte file without changing bytes", async () => {
    const { root, manifest, archive } = await archiveFixture();
    await mkdir(join(root, "fonts"));
    const bytes = Buffer.alloc(16 * 1024 ** 2, 47);
    await writeFile(join(root, "fonts/test.ttf"), bytes);
    const file = await hashBackupFile(root, "fonts/test.ttf", signal());
    manifest.files.push(file);
    manifest.summary.bytes += file.size;
    const updates: number[] = [];
    await writeBackupArchive(
      root,
      archive,
      manifest,
      signal(),
      (current, total, phase) => {
        expect(phase).toBe("backup-compressing");
        expect(total).toBe(manifest.summary.bytes);
        updates.push(current);
      },
    );
    expect(updates[0]).toBe(0);
    expect(updates.at(-1)).toBe(manifest.summary.bytes);
    expect(
      updates.some(
        (current) => current > 2 && current < manifest.summary.bytes,
      ),
    ).toBe(true);
    expect(updates).toEqual([...updates].sort((a, b) => a - b));
    expect(
      (await readFile(archive)).includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])),
    ).toBe(true);
    const target = await temp();
    await extractBackupArchive({
      root: target,
      archive,
      signal: signal(),
      progress,
    });
    expect(
      createHash("sha256")
        .update(await readFile(join(target, "fonts/test.ttf")))
        .digest("hex"),
    ).toBe(file.sha256);
  });
  it("cancels while compressing a large file, keeps the old destination and removes partial output", async () => {
    const { root, manifest, archive } = await archiveFixture();
    const bytes = Buffer.alloc(4 * 1024 ** 2, 47);
    await mkdir(join(root, "fonts"));
    await writeFile(join(root, "fonts/test.ttf"), bytes);
    const file = await hashBackupFile(root, "fonts/test.ttf", signal());
    manifest.files.push(file);
    manifest.summary.bytes += file.size;
    await writeFile(archive, "existing backup");
    const controller = new AbortController();
    await expect(
      writeBackupArchive(
        root,
        archive,
        manifest,
        controller.signal,
        (current) => {
          if (current > 2) controller.abort();
        },
      ),
    ).rejects.toThrow();
    expect(await readFile(archive, "utf8")).toBe("existing backup");
    expect(
      (await readdir(root)).some((name) => name.endsWith(".partial")),
    ).toBe(false);
  });
  it("fails the disk-space preflight", async () => {
    disk.available = 100;
    await expect(assertFreeSpace(await temp(), 1000)).rejects.toThrow(
      "free disk space",
    );
  });
  it("honors cancellation and does not publish a partial archive", async () => {
    const { root, manifest, archive } = await archiveFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      writeBackupArchive(root, archive, manifest, controller.signal, progress),
    ).rejects.toThrow();
    await expect(readFile(archive)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("drains admitted IPC before blocking further writes, while cancellation stays available", async () => {
    let finish!: () => void;
    const pending = trackEnvironmentAccess(
      "settings:save",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    const suspension = suspendEnvironmentAccess();
    await expect(
      trackEnvironmentAccess("settings:save", () => undefined),
    ).rejects.toThrow("backup");
    await expect(
      trackEnvironmentAccess("app-operation:cancel", () => true),
    ).resolves.toBe(true);
    finish();
    await pending;
    const release = await suspension;
    release();
    await expect(
      trackEnvironmentAccess("settings:save", () => true),
    ).resolves.toBe(true);
  });
  it("removes every provider credential, custom payload, local path and hardware override", () => {
    const defaults = resolveDefaultAppSettings({}, null);
    const settings = structuredClone(defaults);
    settings.api.apiKey = "PRIMARY_SECRET";
    settings.api.baseUrl =
      "https://name:PASSWORD@example.test/v1?key=QUERY_SECRET";
    settings.api.customHeadersJson = '{"X-Unrecognized-Auth":"HEADER_SECRET"}';
    settings.api.extraBodyJson = '{"private":"BODY_SECRET"}';
    settings.api.profiles = {
      custom: {
        ...settings.api,
        vertexServiceAccountPath: "C:/PRIVATE/key.json",
      },
    };
    settings.internetResearch.tavilyApiKey = "SEARCH_SECRET";
    settings.api.customProfiles = {
      private: {
        ...(settings.api.profiles.custom ?? settings.api),
        name: "Private",
        sessionHeaderEnabled: true,
        sessionHeaderName: "x-session",
      },
    };
    settings.api.activeCustomProfileId = "private";
    settings.gemma.localModelPath = "D:/model.gguf";
    settings.hardware = { computeGpuIndex: 9 };
    const clean = portableSettings(settings, defaults),
      text = JSON.stringify(clean);
    for (const value of [
      "PRIMARY_SECRET",
      "PASSWORD",
      "QUERY_SECRET",
      "HEADER_SECRET",
      "BODY_SECRET",
      "SEARCH_SECRET",
      "PRIVATE",
      "D:/model.gguf",
    ])
      expect(text).not.toContain(value);
    expect(clean.hardware).toEqual(defaults.hardware);
    expect(clean.translation).toEqual(settings.translation);
    expect(clean.api.customProfiles?.private).toMatchObject({
      name: "Private",
      sessionHeaderEnabled: true,
      sessionHeaderName: "x-session",
      customHeadersJson: "{}",
      extraBodyJson: "{}",
    });
  });
});
