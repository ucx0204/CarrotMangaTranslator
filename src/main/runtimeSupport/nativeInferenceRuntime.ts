import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  join,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} from "node:path";
import {
  assertRuntimeFunctions,
  loadAppRuntimeModule,
} from "../runtimeModuleLoader";
import { ensureRemoteFile, type RuntimeAssetProgress } from "./modelDownloads";
import {
  nativeInferencePlan,
  type NativeInferenceBackend,
  type NativeInferenceEngine,
} from "./nativeInferencePlan";
import {
  createRuntimeStagingDirectory,
  replaceDirectoryWithRollback,
} from "./runtimeDirectoryPublish";

type Options = {
  runtimeDir: string;
  engine: NativeInferenceEngine;
  backend: NativeInferenceBackend;
  rocmTarget?: string;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
};
type Receipt = {
  fingerprint: string;
  files: { path: string; bytes: number; sha256: string }[];
};
type Extractor = (
  archive: string,
  output: string,
  select: (name: string, path: string) => boolean,
  options: { abortSignal?: AbortSignal; preserveRelativePaths?: boolean },
) => Promise<void>;
const pending = new Map<string, Promise<void>>();

export async function ensureNativeInferenceRuntime(options: Options): Promise<{
  directory: string;
  manifest: string;
  pathDirectories: string[];
  executable?: string;
}> {
  options.signal?.throwIfAborted();
  const plan = nativeInferencePlan({
    ...options,
    platform: process.platform,
    arch: process.arch,
  });
  const runtimeRoot =
    process.platform === "win32" && options.backend === "rocm"
      ? toNamespacedPath(resolve(options.runtimeDir))
      : options.runtimeDir;
  const directory = resolve(runtimeRoot, plan.version);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(plan))
    .digest("hex");
  const prior = pending.get(directory);
  if (prior) {
    await waitForPriorInstall(prior, options.signal);
    return ensureNativeInferenceRuntime(options);
  }
  const installation = installRuntime(
    { ...options, runtimeDir: runtimeRoot },
    plan,
    directory,
    fingerprint,
  );
  pending.set(directory, installation);
  try {
    await installation;
  } finally {
    pending.delete(directory);
  }
  options.signal?.throwIfAborted();
  const manifest = join(directory, options.engine + "-runtime.json");
  await writeFile(
    manifest,
    JSON.stringify({
      schema: 1,
      engine: options.engine,
      backend: options.backend,
      libraries: plan.libraries.map((name) => join(directory, name)),
    }),
  );
  return {
    directory,
    manifest,
    ...(plan.executable
      ? { executable: join(directory, plan.executable) }
      : {}),
    pathDirectories: plan.pathDirectories.map((part) => join(directory, part)),
  };
}

async function waitForPriorInstall(
  prior: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolveWait, reject) => {
    const abort = () => reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const finished = () => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason);
      else resolveWait();
    };
    // An independent waiter retries the install after the owner reports its error.
    void prior.then(finished, finished);
  });
}

async function installRuntime(
  options: Options,
  plan: ReturnType<typeof nativeInferencePlan>,
  directory: string,
  fingerprint: string,
): Promise<void> {
  const requiredFiles = [
    ...plan.libraries,
    ...(plan.executable ? [plan.executable] : []),
  ];
  if (await validReceipt(directory, fingerprint, requiredFiles)) return;
  const stage = createRuntimeStagingDirectory(directory);
  await mkdir(stage, { recursive: true });
  try {
    for (const asset of plan.packages) {
      options.signal?.throwIfAborted();
      const archive = await ensureRemoteFile({
        modelDir: join(
          options.runtimeDir,
          ".downloads",
          fingerprint.slice(0, 16),
        ),
        fileName:
          asset.id +
          "-" +
          asset.sha256.slice(0, 12) +
          (asset.format === "zip" ? ".zip" : ".tar.gz"),
        label: "Koharu " + asset.id,
        url: asset.url,
        expectedSha256: asset.sha256,
        minimumBytes: asset.bytes,
        maximumBytes: asset.bytes,
        signal: options.signal,
        onProgress: options.onProgress,
      });
      const functionName =
        asset.format === "zip"
          ? "extractSelectedZipEntries"
          : "extractSelectedTarEntries";
      const module = loadAppRuntimeModule(
        asset.format === "zip" ? "zipExtractor" : "tarExtractor",
      );
      assertRuntimeFunctions(module, "native inference archive", [
        functionName,
      ]);
      const extract = module[functionName] as Extractor;
      await extract(
        archive,
        stage,
        (name, entryPath) =>
          asset.only
            ? asset.only.includes(name)
            : asset.id.startsWith("rocm-")
              ? entryPath.startsWith("_rocm_sdk_core/") ||
                entryPath.startsWith("_rocm_sdk_libraries/")
              : /\.(dll|dylib)$/i.test(name),
        {
          abortSignal: options.signal,
          preserveRelativePaths: asset.preservePaths,
        },
      );
    }
    for (const name of requiredFiles) {
      if (!(await lstat(join(stage, name))).isFile())
        throw new Error("네이티브 런타임 파일이 없습니다: " + name);
    }
    const files = await inventory(stage);
    await writeFile(
      join(stage, ".native-runtime.json"),
      JSON.stringify({ fingerprint, files } satisfies Receipt),
    );
    options.signal?.throwIfAborted();
    await replaceDirectoryWithRollback(stage, directory);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function inventory(
  root: string,
  folder = root,
): Promise<Receipt["files"]> {
  const files: Receipt["files"] = [];
  const entries = await readdir(folder, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(folder, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("런타임 링크는 허용하지 않습니다: " + entry.name);
    if (entry.isDirectory()) files.push(...(await inventory(root, file)));
    else {
      const metadata = await lstat(file);
      files.push({
        path: relative(root, file).split(sep).join("/"),
        bytes: metadata.size,
        sha256: await hashFile(file),
      });
    }
  }
  return files;
}

async function validReceipt(
  directory: string,
  fingerprint: string,
  libraries: string[],
): Promise<boolean> {
  try {
    const receipt = JSON.parse(
      await readFile(join(directory, ".native-runtime.json"), "utf8"),
    ) as Receipt;
    if (
      receipt.fingerprint !== fingerprint ||
      !Array.isArray(receipt.files) ||
      receipt.files.length === 0
    )
      return false;
    const paths = new Set(receipt.files.map((file) => file.path));
    if (
      paths.size !== receipt.files.length ||
      libraries.some((name) => !paths.has(name))
    )
      return false;
    for (const file of receipt.files) {
      if (!(await validReceiptFile(directory, file))) return false;
    }
    return true;
  } catch (_error) {
    // Missing, malformed or unreadable caches are replaced by a verified install.
    return false;
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function validReceiptFile(
  directory: string,
  file: Receipt["files"][number],
): Promise<boolean> {
  const resolved = resolve(directory, file.path);
  if (
    !resolved.startsWith(resolve(directory) + sep) ||
    basename(file.path) === ".native-runtime.json"
  )
    return false;
  const metadata = await lstat(resolved);
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.size === file.bytes &&
    (await hashFile(resolved)) === file.sha256
  );
}
