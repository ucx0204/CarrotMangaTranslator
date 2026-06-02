const { createHash } = require("node:crypto");
const { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } = require("node:fs");
const https = require("node:https");
const { basename, join } = require("node:path");
const AdmZip = require("adm-zip");

const root = join(__dirname, "..");
const cacheDir = join(root, ".tmp", "flux-cuda-redist");
const outDir = join(root, "tools", "mgt-flux-cuda12.9");
const redistBaseUrl = "https://developer.download.nvidia.com/compute/cuda/redist";
const manifestUrl = `${redistBaseUrl}/redistrib_12.9.0.json`;
const requiredDlls = new Set(["cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll"]);

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

  const manifest = await readJson(manifestUrl);
  const packages = [
    manifest?.libcublas?.["windows-x86_64"],
    manifest?.cuda_cudart?.["windows-x86_64"]
  ].filter(Boolean);
  if (packages.length !== 2) {
    throw new Error("NVIDIA CUDA 12.9 redist manifest does not contain required Windows packages.");
  }

  for (const entry of packages) {
    await downloadAndExtract(entry);
  }
  if (!hasRequiredDlls(outDir)) {
    throw new Error(`Flux CUDA 12.9 runtime is incomplete: ${outDir}`);
  }
  console.log(`Prepared Flux CUDA 12.9 runtime: ${outDir}`);
}

async function downloadAndExtract(entry) {
  const url = `${redistBaseUrl}/${entry.relative_path}`;
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
  for (const item of zip.getEntries()) {
    if (item.isDirectory) {
      continue;
    }
    const name = basename(item.entryName);
    if (!requiredDlls.has(name)) {
      continue;
    }
    writeFileSync(join(outDir, name), item.getData());
    console.log(`Extracted ${name}`);
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
  return [...requiredDlls].every((file) => {
    try {
      return statSync(join(dir, file)).size > 0;
    } catch {
      return false;
    }
  });
}

function unlinkIfExists(path) {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
