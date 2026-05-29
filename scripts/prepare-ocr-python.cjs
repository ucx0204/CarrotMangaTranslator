const { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { get } = require("node:https");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const root = join(__dirname, "..");
const pythonVersion = process.env.MANGA_TRANSLATOR_EMBED_PYTHON_VERSION || "3.12.7";
const pythonUrl =
  process.env.MANGA_TRANSLATOR_EMBED_PYTHON_URL ||
  `https://www.python.org/ftp/python/${pythonVersion}/python-${pythonVersion}-embed-amd64.zip`;
const getPipUrl = process.env.MANGA_TRANSLATOR_GET_PIP_URL || "https://bootstrap.pypa.io/get-pip.py";
const toolsDir = join(root, "tools");
const pythonDir = join(toolsDir, "python");
const tmpDir = join(root, ".tmp", "ocr-python");
const pythonExe = join(pythonDir, "python.exe");

async function main() {
  if (process.platform !== "win32") {
    console.log("[ocr-python] skipping embedded Python download on non-Windows host");
    return;
  }

  if (existsSync(pythonExe)) {
    sanitizePythonPathFile(pythonDir);
    console.log(`[ocr-python] already prepared: ${pythonExe}`);
    return;
  }

  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(pythonDir, { recursive: true });

  const zipPath = join(tmpDir, "python-embed-amd64.zip");
  const getPipPath = join(tmpDir, "get-pip.py");
  await download(pythonUrl, zipPath);
  expandArchive(zipPath, pythonDir);
  sanitizePythonPathFile(pythonDir);
  await download(getPipUrl, getPipPath);
  run(pythonExe, [getPipPath, "--no-warn-script-location"]);
  console.log(`[ocr-python] prepared: ${pythonExe}`);
}

function download(url, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`[ocr-python] downloading ${url}`);
    const file = createWriteStream(outputPath);
    get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
        file.close();
        download(response.headers.location, outputPath).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        reject(new Error(`Download failed (${response.statusCode}) for ${url}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => {
        file.close(resolve);
      });
    }).on("error", (error) => {
      file.close();
      reject(error);
    });
  });
}

function expandArchive(zipPath, outputDir) {
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(outputDir)} -Force`
  ]);
}

function sanitizePythonPathFile(outputDir) {
  const pthName = readdirSync(outputDir).find((name) => /^python\d+._pth$/i.test(name));
  if (!pthName) {
    return;
  }

  const pthPath = join(outputDir, pthName);
  const text = readFileSync(pthPath, "utf8");
  const lines = text.split(/\r?\n/);
  const sanitized = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "#import site" || trimmed === "import site") {
      continue;
    }
    if (isManagedOcrPackagePath(trimmed)) {
      continue;
    }
    if (!trimmed && sanitized[sanitized.length - 1] === "") {
      continue;
    }
    sanitized.push(line);
  }

  while (sanitized.length > 0 && sanitized[sanitized.length - 1] === "") {
    sanitized.pop();
  }
  if (sanitized.length > 0) {
    sanitized.push("");
  }
  sanitized.push("import site");

  const nextText = `${sanitized.join("\n")}\n`;
  if (nextText !== text) {
    writeFileSync(pthPath, nextText, "utf8");
  }
}

function isManagedOcrPackagePath(line) {
  if (!line || line.startsWith("#")) {
    return false;
  }

  const normalized = line.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.split("/").pop() || "";
  return (
    basename.startsWith("python-packages") ||
    normalized.includes("/manga-gemma-translator/ocr-runtime/") ||
    normalized.includes("/mgt-ocr-runtime/") ||
    normalized.includes("/.tmp/ocr-runtime/")
  );
}

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const env = { ...process.env };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  delete env.PYTHONUSERBASE;
  const result = spawnSync(command, args, {
    cwd: root,
    env: {
      ...env,
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
      PYTHONUNBUFFERED: "1"
    },
    stdio: "inherit",
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status ?? "null"}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
