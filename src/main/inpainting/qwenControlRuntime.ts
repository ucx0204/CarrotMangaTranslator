import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { sha256File } from "../runtimeSupport/fileProbe";
import {
  ensureRemoteFile,
  type RuntimeAssetProgress,
} from "../runtimeSupport/modelDownloads";
import {
  createRuntimeStagingDirectory,
  replaceDirectoryWithRollback,
} from "../runtimeSupport/runtimeDirectoryPublish";
import { extractZipSafely } from "./fluxAssets/downloads";

const execute = promisify(execFile);
export const qwenPrintTools = "print-opencv-4.11.0.86";
const revision = "ff8d48666758866bcc9e93b22e1e07cb636e084f";
const upstream = "ComfyUI_windows_portable";
const nodeDir = "ComfyUI-GGUF-" + revision;
const assets = [
  {
    name: "ComfyUI_windows_portable_nvidia.7z",
    url: "https://github.com/Comfy-Org/ComfyUI/releases/download/v0.46.0/ComfyUI_windows_portable_nvidia.7z",
    bytes: 2_085_169_944,
    sha256: "6a5255c7ec01fdc54bdbd8e4507073cf6acda2fbeea74ae1829a50681af5fac6",
  },
  {
    name: "gguf-" + revision + ".zip",
    url: "https://codeload.github.com/leejet/ComfyUI-GGUF/zip/" + revision,
    bytes: 39_234,
    sha256: "e702e2945d6b9a3ce8197145cbedf96434c85bc93cfbda6922534acc0d0b31e1",
  },
  {
    name: "gguf-0.19.0-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/b3/bb/d71d6da82763528c2c2ed6b59a9d6142c6595545a4c448e2085d155e88c2/gguf-0.19.0-py3-none-any.whl",
    bytes: 118_475,
    sha256: "70bcd10edfe697fb2dad6e40af2234b9d8ece9a41a99761405121ebda1c3c1cd",
  },
] as const;

const required = new Map([
  [
    upstream + "/python_embeded/python.exe",
    "ef8f51028ac5329641985112f8efb1c2d4c47c86b8011ddf7e6fae21e2b4e5a1",
  ],
  [
    upstream + "/ComfyUI/nodes.py",
    "8e2963260314f6b4da4cf1ebe94c5cf00d0617d4844fa8f96cc2eeda224c0700",
  ],
  [
    upstream + "/ComfyUI/comfy_extras/nodes_qwen.py",
    "61a5e27f90bb786cd4f6e76ee86920582ffef2ee3e65cde7b2278c7171c559e8",
  ],
  [
    upstream + "/ComfyUI/comfy_extras/nodes_model_patch.py",
    "25e2e0ee146084f52ab34a39e3a4ab7ca5120acec7fe3007fcaeeca7ca463e39",
  ],
  [
    "node/" + nodeDir + "/nodes.py",
    "16be3b08b13de6279fc432addc628320019fcb24963cbc6b52b248de8f06316e",
  ],
  [
    "packages/gguf/__init__.py",
    "3ccfc0104cd7ea88c6028743b7bf3f2c89b5f474425de03a217a6072320d7c2f",
  ],
]);

type Options = {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
};

export async function supportsQwenControlRuntime(
  computeCapability: number | null | undefined,
  signal?: AbortSignal,
) {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    (computeCapability ?? 0) < 7.5
  )
    return false;
  const { stdout } = await execute("nvidia-smi", ["--version"], {
    signal,
    windowsHide: true,
    timeout: 5000,
  });
  return (
    Number(/^CUDA(?: UMD)? version\s*:\s*(\d+)\./im.exec(stdout)?.[1] ?? 0) >=
    13
  );
}

function paths(root: string) {
  return {
    executable: join(root, upstream, "python_embeded", "python.exe"),
    comfy: join(root, upstream, "ComfyUI"),
    nodeDirectory: join(root, "node", nodeDir),
    packageDirectory: join(root, "packages"),
  };
}

export function installedQwenControlPython(dataRoot: string) {
  return paths(
    join(
      dataRoot,
      "models",
      "inpainting",
      "qwen-image-runtime",
      "control-v0460-cu130-ff8d486",
    ),
  ).executable;
}

async function installed(root: string) {
  try {
    for (const [path, hash] of required) {
      const file = join(root, path);
      if (!(await lstat(file)).isFile() || (await sha256File(file)) !== hash)
        return false;
    }
    const torch = join(
      root,
      upstream,
      "python_embeded",
      "Lib",
      "site-packages",
      "torch",
      "lib",
    );
    return (await lstat(join(torch, "torch_cuda.dll"))).isFile();
  } catch (_error) {
    // A missing or partially extracted cache is rebuilt from the pinned archives.
    return false;
  }
}

async function extractPortable(
  archive: string,
  dest: string,
  signal?: AbortSignal,
) {
  // The publisher's immutable archive contains only ordinary files and
  // directories. Check both the names and types before invoking Windows bsdtar.
  const tar = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "tar.exe",
  );
  const opts = { windowsHide: true, signal, maxBuffer: 32 * 1024 * 1024 };
  const { stdout: listing } = await execute(tar, ["-tf", archive], opts);
  const names = listing.trimEnd().split(/\r?\n/);
  const unsafe = names.some(
    (name) =>
      !name.startsWith(upstream + "/") ||
      name.split("/").includes("..") ||
      /[\\:\x00-\x1f]/.test(name),
  );
  if (unsafe || names.length !== 70_172)
    throw new Error("Qwen 런타임 압축 파일의 경로 목록이 올바르지 않습니다.");
  const { stdout: details } = await execute(tar, ["-tvf", archive], opts);
  const modes = details.trimEnd().split(/\r?\n/);
  if (
    modes.length !== names.length ||
    modes.some((line) => !/^[-d]/.test(line))
  ) {
    throw new Error("Qwen 런타임 압축 파일에 지원하지 않는 항목이 있습니다.");
  }
  await execute(
    tar,
    [
      "-xf",
      archive,
      "-C",
      dest,
      "--exclude",
      "*/.git",
      upstream + "/python_embeded",
      upstream + "/ComfyUI",
    ],
    opts,
  );
}

async function install(options: Options, root: string) {
  if (await installed(root)) return;
  const stage = createRuntimeStagingDirectory(root);
  await mkdir(stage, { recursive: true });
  try {
    const archives: string[] = [];
    for (const asset of assets) {
      archives.push(
        await ensureRemoteFile({
          modelDir: join(options.runtimeDir, "downloads"),
          fileName: asset.name,
          url: asset.url,
          label: "Qwen Image 2.1 · " + asset.name,
          minimumBytes: asset.bytes,
          maximumBytes: asset.bytes,
          expectedTotalBytes: asset.bytes,
          expectedSha256: asset.sha256,
          signal: options.signal,
          onProgress: options.onProgress,
        }),
      );
    }
    await extractPortable(archives[0], stage, options.signal);
    await extractZipSafely(archives[1], join(stage, "node"), options.signal);
    await extractZipSafely(
      archives[2],
      join(stage, "packages"),
      options.signal,
    );
    if (!(await installed(stage)))
      throw new Error("Qwen ControlNet 런타임 파일 검증에 실패했습니다.");
    options.signal?.throwIfAborted();
    await replaceDirectoryWithRollback(stage, root);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const pending = new Map<string, Promise<void>>();
async function installPrintTools(options: Options, root: string) {
  const destination = join(root, qwenPrintTools);
  const binding = new Map([
    [
      "cv2/cv2.pyd",
      "cb94fb2b0224b1ea1dffef2e69ed56467df2c57f00b8ce88c89ff76a08b39d00",
    ],
    [
      "cv2/__init__.py",
      "957a91bfd98ffb07a10cd789b7c5c46806568476b61e34c7ad56a00092b981a5",
    ],
    [
      "cv2/config.py",
      "d9e401b9a67304d69c48a494a485d106b534e02bf5776211c09f09bd671b295d",
    ],
    [
      "cv2/config-3.py",
      "de28c7b5213cca148f09469916584611b3d66c1c8c432880259d6a3a92380213",
    ],
  ]);
  const verified = async (directory: string) => {
    for (const [name, digest] of binding) {
      const file = join(directory, name);
      try {
        if (
          !(await lstat(file)).isFile() ||
          (await sha256File(file)) !== digest
        )
          return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }
    return true;
  };
  if (await verified(destination)) return;
  const name = "opencv_python_headless-4.11.0.86-cp37-abi3-win_amd64.whl";
  const wheel = await ensureRemoteFile({
    modelDir: join(options.runtimeDir, "downloads"),
    fileName: name,
    url:
      "https://files.pythonhosted.org/packages/86/8a/69176a64335aed183529207ba8bc3d329c2999d852b4f3818027203f50e6/" +
      name,
    label: "Qwen Image 2.1 · 원본 선 복원",
    minimumBytes: 39402386,
    maximumBytes: 39402386,
    expectedTotalBytes: 39402386,
    expectedSha256:
      "6c304df9caa7a6a5710b91709dd4786bf20a74d57672b3c31f7033cc638174ca",
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const stage = createRuntimeStagingDirectory(destination);
  try {
    await mkdir(stage, { recursive: true });
    await extractZipSafely(wheel, stage, options.signal);
    if (!(await verified(stage)))
      throw new Error("Qwen 원본 선 복원 도구를 검증할 수 없습니다.");
    options.signal?.throwIfAborted();
    await replaceDirectoryWithRollback(stage, destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export async function ensureQwenControlRuntime(
  options: Options,
): Promise<ReturnType<typeof paths>> {
  const root = join(options.runtimeDir, "control-v0460-cu130-ff8d486");
  options.signal?.throwIfAborted();
  const other = pending.get(root);
  if (other) {
    await Promise.allSettled([other]);
    return ensureQwenControlRuntime(options);
  }
  const job = install(options, root).then(() =>
    installPrintTools(options, root),
  );
  pending.set(root, job);
  try {
    await job;
    options.signal?.throwIfAborted();
    return paths(root);
  } finally {
    pending.delete(root);
  }
}

export function qwenKoffiPath(runtimeDir: string) {
  const bundledBinding = join(runtimeDir, "koffi.node");
  return existsSync(bundledBinding) ? bundledBinding : require.resolve("koffi");
}
