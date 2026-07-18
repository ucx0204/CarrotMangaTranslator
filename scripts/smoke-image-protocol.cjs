// @ts-check
const { app, BrowserWindow, net } = require("electron");
const { renameSync, writeFileSync } = require("node:fs");
const { mkdir, rm, writeFile } = require("node:fs/promises");
const { isAbsolute, join, relative, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const root = join(__dirname, "..");
const resultPath = process.env.MGT_IMAGE_PROTOCOL_SMOKE_RESULT_PATH;
const userDataDir = process.env.MGT_IMAGE_PROTOCOL_SMOKE_USER_DATA;
const pixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

if (!resultPath || !userDataDir) {
  throw new Error("Image protocol smoke paths are missing.");
}
assertPathInsideRoot(userDataDir, root);
assertPathInsideRoot(resultPath, resolve(userDataDir, ".."));
app.setPath("userData", userDataDir);
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.on("window-all-closed", () => {});

const imageProtocol =
  /** @type {typeof import("../src/main/imageProtocol")} */ (
    require(join(root, "out", "main", "imageProtocol.js"))
  );
imageProtocol.registerImageProtocolScheme();

let smokeResult = {
  ok: false,
  message: "Electron exited before the image protocol smoke completed.",
};
process.on("exit", () => {
  try {
    const temporaryResultPath = `${resultPath}.${process.pid}.tmp`;
    writeFileSync(temporaryResultPath, JSON.stringify(smokeResult), "utf8");
    renameSync(temporaryResultPath, resultPath);
  } catch (_error) {
    // error-policy-allow: the parent process will report a timeout if the result cannot be written.
  }
});

async function main() {
  await app.whenReady();
  const { getLibraryRoot } =
    /** @type {typeof import("../src/main/library")} */ (
      require(join(root, "out", "main", "library.js"))
    );
  const libraryRoot = getLibraryRoot();
  const smokeImageRoot = join(
    libraryRoot,
    `.image-protocol-smoke-${process.pid}`,
  );
  assertPathInsideRoot(smokeImageRoot, libraryRoot);
  await rm(smokeImageRoot, { force: true, recursive: true });

  const imagePath = join(
    smokeImageRoot,
    `long-${"a".repeat(100)}`,
    `long-${"b".repeat(100)}`,
    "pixel.png",
  );
  let window;
  try {
    await mkdir(resolve(imagePath, ".."), { recursive: true });
    await writeFile(imagePath, pixelPng);
    if (process.platform === "win32" && imagePath.length < 270) {
      throw new Error(
        `Smoke image path is not long enough: ${imagePath.length}`,
      );
    }

    imageProtocol.registerImageProtocolHandler();
    const imageUrl = imageProtocol.createLibraryImageUrl(imagePath);
    const response = await withTimeout(
      net.fetch(imageUrl),
      10_000,
      "Timed out fetching the long-path image protocol URL.",
    );
    const responseBytes = Buffer.from(await response.arrayBuffer());
    if (response.status !== 200 || !responseBytes.equals(pixelPng)) {
      throw new Error(
        `Long-path protocol fetch failed: ${response.status}, ${responseBytes.length} bytes`,
      );
    }

    window = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const html = `<!doctype html>
      <img id="image" alt="long-path-image">
      <script>document.getElementById("image").src = ${JSON.stringify(imageUrl)};</script>`;
    const smokePagePath = join(smokeImageRoot, "smoke.html");
    await writeFile(smokePagePath, html, "utf8");
    await withTimeout(
      window.loadURL(pathToFileURL(smokePagePath).href),
      10_000,
      "Timed out loading the image protocol smoke page.",
    );
    const renderResult =
      /** @type {{ complete: boolean; naturalHeight: number; naturalWidth: number }} */ (
        await withTimeout(
          window.webContents.executeJavaScript(`
            new Promise((resolve) => {
              const image = document.getElementById("image");
              const finish = () => resolve({
                complete: image.complete,
                naturalHeight: image.naturalHeight,
                naturalWidth: image.naturalWidth,
              });
              if (image.complete) finish();
              else {
                image.addEventListener("load", finish, { once: true });
                image.addEventListener("error", finish, { once: true });
              }
            })
          `),
          10_000,
          "Timed out rendering the long-path image.",
        )
      );
    if (
      !renderResult.complete ||
      renderResult.naturalWidth !== 1 ||
      renderResult.naturalHeight !== 1
    ) {
      throw new Error(
        `Long-path image failed to render: ${JSON.stringify(renderResult)}`,
      );
    }
  } finally {
    window?.destroy();
    await rm(smokeImageRoot, { force: true, recursive: true });
  }
  return imagePath.length;
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs, message) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  return Promise.race([
    promise.finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

/**
 * @param {string} targetPath
 * @param {string} expectedRoot
 */
function assertPathInsideRoot(targetPath, expectedRoot) {
  const resolvedRoot = resolve(expectedRoot);
  const resolvedTarget = resolve(targetPath);
  const child = relative(resolvedRoot, resolvedTarget);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`Refusing to clean unexpected smoke path: ${targetPath}`);
  }
}

main().then(
  (imagePathLength) => {
    smokeResult = {
      ok: true,
      message: `image protocol long-path smoke passed (${imagePathLength} chars)`,
    };
    app.exit(0);
  },
  (error) => {
    console.error(error);
    smokeResult = {
      ok: false,
      message:
        error instanceof Error ? error.stack || error.message : String(error),
    };
    app.exit(1);
  },
);
