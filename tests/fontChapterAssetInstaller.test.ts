import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFontChapterAssets } from "../src/main/pipeline/fontChapterAssetInstaller";
import {
  verifyFontChapterAssetFile,
  verifyFontChapterAssets,
} from "../src/main/pipeline/fontChapterAssetVerification";

const download = vi.hoisted(() => vi.fn());
vi.mock("../src/main/runtimeSupport/modelDownloads", () => ({
  ensureRemoteFile: download,
}));
const roots: string[] = [];
afterEach(async () => {
  download.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function record(path: string, data: Buffer) {
  return {
    path,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}
async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "fc23-test-"));
  roots.push(dataRoot);
  const model = Buffer.from("sealed model");
  const dependency = Buffer.from("native dependency");
  const inventory = Buffer.from(
    JSON.stringify({
      files: [record("python-packages/native.bin", dependency)],
    }),
  );
  const manifest = {
    assetDirectory: "models/c23/test",
    files: [
      record("model.onnx", model),
      record("python-inventory.json", inventory),
    ],
  };
  const zip = new AdmZip();
  zip.addFile("model.onnx", model);
  zip.addFile("python-inventory.json", inventory);
  zip.addFile("python-packages/native.bin", dependency);
  const archivePath = join(dataRoot, "fixture.zip");
  await writeFile(archivePath, zip.toBuffer());
  download.mockResolvedValue(archivePath);
  return {
    paths: { dataRoot, runtimeDir: resolve("src/main/runtime") },
    manifest,
    archive: record("font.zip", await readFile(archivePath)),
    url: "https://example.test/font.zip",
    zip,
    archivePath,
  };
}

describe("font chapter asset installation", () => {
  it("propagates cancellation during cached-file verification without starting a repair download", async () => {
    const options = await fixture();
    await installFontChapterAssets(options);
    const controller = new AbortController();
    const pending = installFontChapterAssets({
      ...options,
      signal: controller.signal,
    });
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toThrow();
    expect(download).toHaveBeenCalledOnce();
    await installFontChapterAssets(options);
    expect(download).toHaveBeenCalledOnce();
  });
  it("installs the real archive once for concurrent callers and repairs altered dependency bytes", async () => {
    const options = await fixture();
    const [first, second] = await Promise.all([
      installFontChapterAssets(options),
      installFontChapterAssets(options),
    ]);
    expect(first).toBe(second);
    expect(download).toHaveBeenCalledTimes(1);
    await writeFile(join(first, "python-packages/native.bin"), "changed");
    await installFontChapterAssets(options);
    expect(download).toHaveBeenCalledTimes(2);
    expect(
      (await readFile(join(first, "python-packages/native.bin"))).toString(),
    ).toBe("native dependency");
    expect(await readdir(join(options.paths.dataRoot, "models/c23"))).toEqual([
      "test",
    ]);
  });

  it("does not publish a corrupt archive or remove the previous installation", async () => {
    const options = await fixture();
    const target = await installFontChapterAssets(options);
    await writeFile(join(target, "model.onnx"), "old damaged file");
    options.zip.updateFile("model.onnx", Buffer.from("wrong"));
    await writeFile(options.archivePath, options.zip.toBuffer());
    await expect(installFontChapterAssets(options)).rejects.toThrow("mismatch");
    expect((await readFile(join(target, "model.onnx"))).toString()).toBe(
      "old damaged file",
    );
    expect(await readdir(join(options.paths.dataRoot, "models/c23"))).toEqual([
      "test",
    ]);
  });

  it("cancels a queued caller without cancelling the active installation", async () => {
    const options = await fixture();
    let unblock!: (path: string) => void;
    download.mockImplementationOnce(
      () =>
        new Promise<string>((done) => {
          unblock = done;
        }),
    );
    const active = installFontChapterAssets(options);
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const waiting = installFontChapterAssets({
      ...options,
      signal: controller.signal,
    });
    const assertion = expect(waiting).rejects.toThrow("Aborted");
    controller.abort();
    await assertion;
    unblock(options.archivePath);
    await active;
    await expect(
      installFontChapterAssets({ ...options, signal: controller.signal }),
    ).rejects.toThrow("Aborted");
    expect(download).toHaveBeenCalledOnce();
  });

  it("rejects traversal, duplicate inventory entries, missing inventories and digest drift", async () => {
    const options = await fixture();
    const target = await installFontChapterAssets(options);
    const model = options.manifest.files[0];
    if (!model) throw new Error("Missing fixture model");
    await expect(
      verifyFontChapterAssetFile(target, { ...model, path: "../model.onnx" }),
    ).rejects.toThrow("escapes");
    await expect(
      verifyFontChapterAssetFile(target, { ...model, path: "a\\b" }),
    ).rejects.toThrow("Unsafe");
    await expect(
      verifyFontChapterAssetFile(target, {
        ...model,
        path: resolve(target, "model.onnx"),
      }),
    ).rejects.toThrow("Unsafe");
    await symlink(
      join(target, "python-packages"),
      join(target, "linked"),
      "junction",
    );
    const dep = Buffer.from("native dependency");
    await expect(
      verifyFontChapterAssetFile(target, record("linked/native.bin", dep)),
    ).rejects.toThrow("Linked");
    await expect(
      verifyFontChapterAssets(target, { ...options.manifest, files: [model] }),
    ).rejects.toThrow("inventory is missing");
    await expect(
      verifyFontChapterAssets(target, {
        ...options.manifest,
        files: [...options.manifest.files, model],
      }),
    ).rejects.toThrow("Duplicate");
    await writeFile(join(target, "model.onnx"), "sealed wrong");
    await expect(verifyFontChapterAssetFile(target, model)).rejects.toThrow(
      "digest mismatch",
    );
    await mkdir(join(target, "directory"));
    await expect(
      verifyFontChapterAssetFile(target, { ...model, path: "directory" }),
    ).rejects.toThrow("type mismatch");
  });
});
