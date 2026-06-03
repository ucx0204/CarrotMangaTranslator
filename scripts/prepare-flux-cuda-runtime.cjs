const { createHash } = require("node:crypto");
const { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } = require("node:fs");
const https = require("node:https");
const { basename, join } = require("node:path");
const AdmZip = require("adm-zip");

const root = join(__dirname, "..");
const cacheDir = join(root, ".tmp", "flux-cuda-redist");
const outDir = join(root, "tools", "mgt-flux-cuda12.9");
const cudaRedistBaseUrl = "https://developer.download.nvidia.com/compute/cuda/redist";
const cudnnRedistBaseUrl = "https://developer.download.nvidia.com/compute/cudnn/redist";
const cudaManifestUrl = `${cudaRedistBaseUrl}/redistrib_12.9.0.json`;
const cudnnManifestUrl = `${cudnnRedistBaseUrl}/redistrib_9.21.0.json`;
const requiredCudaDlls = new Set(["cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll", "curand64_10.dll"]);
const cudnnDllPattern = /^cudnn.*\.dll$/i;

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

async function main() {
  if (hasRequiredDlls(outDir)) {
    console.log(`Flux CUDA 12.9 runtime already exists: ${outDir}`);
    return;
  }
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const cudaManifest = await readJson(cudaManifestUrl);
  const cudaPackages = [
    cudaManifest?.libcublas?.["windows-x86_64"],
    cudaManifest?.cuda_cudart?.["windows-x86_64"],
    cudaManifest?.libcurand?.["windows-x86_64"]
  ].filter(Boolean);
  if (cudaPackages.length !== 3) {
    throw new Error("NVIDIA CUDA 12.9 redist manifest does not contain required Windows packages.");
  }

  for (const entry of cudaPackages) {
    await downloadAndExtract(entry, {
      baseUrl: cudaRedistBaseUrl,
      label: "CUDA",
      shouldExtract: (name) => requiredCudaDlls.has(name)
    });
  }

  const cudnnManifest = await readJson(cudnnManifestUrl);
  const cudnnPackage = cudnnManifest?.cudnn?.["windows-x86_64"]?.cuda12;
  if (!cudnnPackage) {
    throw new Error("NVIDIA cuDNN redist manifest does not contain the required Windows CUDA 12 package.");
  }
  await downloadAndExtract(cudnnPackage, {
    baseUrl: cudnnRedistBaseUrl,
    label: "cuDNN",
    shouldExtract: (name) => cudnnDllPattern.test(name)
  });

  if (!hasRequiredDlls(outDir)) {
    throw new Error(`Flux CUDA 12.9 runtime is incomplete: ${outDir}`);
  }
  console.log(`Prepared Flux CUDA 12.9 runtime: ${outDir}`);
}

async function downloadAndExtract(entry, options) {
  const url = `${options.baseUrl}/${entry.relative_path}`;
  const archivePath = join(cacheDir, basename(entry.relative_path));
  const expectedSize = Number(entry.size);
  let needsDownload = true;
  const archiveExists = existsSync(archivePath);
  if (archiveExists) {
    const actualSize = statSync(archivePath).size;
    const actualHash = actualSize === expectedSize ? hashFile(archivePath) : "";
    needsDownload = actualSize !== expectedSize || actualHash !== entry.sha256;
  }
  if (needsDownload) {
    unlinkIfExists(archivePath);
    console.log(`Downloading ${url}`);
    await downloadFile(url, archivePath);
    const actualHash = hashFile(archivePath);
    if (actualHash !== entry.sha256) {
      unlinkIfExists(archivePath);
      throw new Error(`Downloaded CUDA redist hash mismatch for ${url}`);
    }
  }

  const zip = new AdmZip(archivePath);
  let extractedCount = 0;
  for (const item of zip.getEntries()) {
    if (item.isDirectory) {
      continue;
    }
    const name = basename(item.entryName);
    if (!options.shouldExtract(name)) {
      continue;
    }
    writeFileSync(join(outDir, name), item.getData());
    extractedCount += 1;
    console.log(`Extracted ${options.label} ${name}`);
  }
  if (extractedCount === 0) {
    throw new Error(`No ${options.label} runtime DLLs matched in ${archivePath}`);
  }
}

async function readJson(url) {
  const text = await readUrl(url);
  return JSON.parse(text);
}

function readUrl(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`GET ${url} failed with ${response.statusCode}`));
          return;
        }
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => resolve(text));
      })
      .on("error", reject);
  });
}

async function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`GET ${url} failed with ${response.statusCode}`));
          return;
        }
        const output = createWriteStream(destination);
        response.pipe(output);
        output.on("finish", () => output.close(resolve));
        output.on("error", reject);
        response.on("error", reject);
      })
      .on("error", reject);
  });
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hasRequiredDlls(dir) {
  const hasCudaDlls = [...requiredCudaDlls].every((file) => {
    try {
      return statSync(join(dir, file)).size > 0;
    } catch {
      return false;
    }
  });
  return hasCudaDlls && hasCudnnDll(dir);
}

function hasCudnnDll(dir) {
  try {
    const cudnnPath = join(dir, "cudnn64_9.dll");
    if (statSync(cudnnPath).size > 0) {
      return true;
    }
  } catch {
    // Fall through to the broader check below.
  }
  try {
    const { readdirSync } = require("node:fs");
    return readdirSync(dir).some((file) => {
      if (!cudnnDllPattern.test(file)) {
        return false;
      }
      try {
        return statSync(join(dir, file)).size > 0;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function unlinkIfExists(path) {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
