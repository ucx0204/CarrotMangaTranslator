const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { cp, mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { promisify } = require("node:util");
const { app, nativeImage } = require("electron");
const { runMcpWebProbe } = require("./mcp-web-probe.cjs");
const { runMcpBrowserConsentProbe } = require("./mcp-browser-consent.cjs");
const { checkNativeAuthorization } = require("./mcp-native-authorization.cjs");

const root = resolve(__dirname, "..");
const exec = promisify(execFile);

// This test owns Electron's lifetime. Closing the first isolated consent window
// must not trigger Electron's default successful exit before assertions/cleanup.
app.on("window-all-closed", () => {
  console.log(
    "[mcp-smoke] Consent window closed; continuing owned acceptance checks.",
  );
});

/** @param {string} dataRoot */
async function importFixture(dataRoot) {
  const { getAppPaths } = require(join(dataRoot, "out/main/appPaths.js"));
  assert.equal(
    getAppPaths().dataRoot,
    dataRoot,
    "Never use a real user data root",
  );
  const library = require(join(dataRoot, "out/main/library.js"));
  const sourcePath = join(dataRoot, "sample.png");
  const image = nativeImage.createFromBitmap(Buffer.alloc(32 * 48 * 4, 255), {
    width: 32,
    height: 48,
  });
  await writeFile(sourcePath, image.toPNG());
  return library.createImport({
    preview: {
      mode: "single",
      sourceKind: "images",
      suggestedWorkTitle: "MCP smoke fixture",
      chapters: [
        {
          draftId: "sample",
          title: "Sample",
          sourceKind: "images",
          pages: [{ name: "sample.png", sourcePath, sourceKind: "file" }],
        },
      ],
    },
    target: { mode: "new", title: "MCP smoke fixture" },
    selections: [{ draftId: "sample", title: "Sample", enabled: true }],
  });
}

/** @param {string} url @param {string} token @param {string} name @param {object} [args] */
async function call(url, token, name, args = {}) {
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

/** @param {string} dataRoot @param {string} url @param {string} token @param {string} chapterId */
async function checkRedaction(dataRoot, url, token, chapterId) {
  const result = await call(url, token, "carrot_get_chapter", { chapterId });
  const chapter = JSON.parse(result.content[0].text);
  const redaction = require(join(dataRoot, "out/main/imageRedactionStore.js"));
  await redaction.setImageRedactionEnabled(true, dataRoot);
  const blocked = await call(url, token, "carrot_get_page_preview", {
    chapterId,
    pageId: chapter.pages[0].id,
  });
  assert.equal(blocked.isError, true);
  assert.equal(
    blocked.content.some(
      (/** @type {{type: string}} */ item) => item.type === "image",
    ),
    false,
  );
  assert.equal(JSON.stringify(blocked).includes(dataRoot), false);
  console.log("PASS real Electron redaction gate blocked image transfer");
}

/** @param {string} dataRoot */
async function checkRuntime(dataRoot) {
  const tailscale = require(join(dataRoot, "out/main/mcp/mcpTailscale.js"));
  const target =
    process.env.CARROT_MCP_SMOKE_TAILSCALE === "1"
      ? await tailscale.prepareTailscale()
      : undefined;
  const imported = await importFixture(dataRoot);
  const { createMcpRuntime } = require(
    join(dataRoot, "out/main/mcpRuntime.js"),
  );
  const token = randomBytes(32).toString("base64url");
  const password = randomBytes(32).toString("base64url");
  const issuer = target?.origin ?? "https://carrot-native-test.example";
  let url = "";
  /** @type {unknown[]} */
  const errors = [];
  const runtime = createMcpRuntime({
    env: {
      CARROT_MCP_ENABLED: "1",
      CARROT_MCP_TOKEN: token,
      CARROT_MCP_PORT: "38475",
      CARROT_MCP_ALLOW_IMAGES: "1",
      CARROT_MCP_PUBLIC_ORIGIN: issuer,
      CARROT_MCP_OAUTH_ENABLED: "1",
      CARROT_MCP_OAUTH_PASSWORD: password,
    },
    reportError: (
      /** @type {string} */ _message,
      /** @type {unknown} */ error,
    ) => errors.push(error),
    reportInfo: (
      /** @type {string} */ _message,
      /** @type {{url: string}} */ detail,
    ) => {
      url = detail.url;
    },
  });
  let preview;
  let tunnel;
  let failure;
  try {
    await runtime.start();
    assert.ok(url.endsWith("/mcp"));
    await runMcpWebProbe(url, password, issuer);
    if (target) {
      tunnel = await tailscale.openTailscale(
        target,
        38475,
        AbortSignal.timeout(30_000),
        () => runtime.stopAccepting(),
      );
      await runMcpWebProbe(`${issuer}/mcp`, password);
      await runMcpBrowserConsentProbe(issuer, password);
      console.log("PASS live Tailscale HTTPS and isolated browser consent");
    }

    const { stdout } = await exec(
      "node",
      [join(root, "scripts/mcp-smoke.mjs"), "--first-preview"],
      {
        env: { ...process.env, CARROT_MCP_TOKEN: token, CARROT_MCP_URL: url },
        timeout: 25_000,
      },
    );
    preview = stdout.match(/PASS PNG preview saved: ([^\r\n]+)/)?.[1];
    assert.ok(preview);
    console.log(stdout);
    assert.deepEqual(errors, []);
    await checkRedaction(dataRoot, url, token, imported.chapterIds[0]);
  } catch (error) {
    failure = error;
  }
  await finishRuntime(runtime, tunnel, preview, failure);
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
  console.log("PASS real Electron MCP runtime stopped and listener closed");
}

async function main() {
  await app.whenReady();
  await mkdir(join(root, ".tmp"), { recursive: true });
  const dataRoot = await mkdtemp(join(root, ".tmp/mcp-native-"));
  try {
    // Only built code/runtime assets are copied, never a user library or settings.
    for (const directory of ["main", "shared", "app-runtime"]) {
      await cp(join(root, "out", directory), join(dataRoot, "out", directory), {
        recursive: true,
      });
    }
    await checkRuntime(dataRoot);
    await checkNativeAuthorization(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().then(
  () => {
    console.log("PASS MCP native smoke finished");
    app.exit(0);
  },
  (error) => {
    console.error(error);
    app.exit(1);
  },
);

/** @param {{dispose: () => Promise<void>}} runtime @param {{close: () => Promise<void>} | undefined} tunnel @param {string | undefined} preview @param {unknown} failure */
async function finishRuntime(runtime, tunnel, preview, failure) {
  const cleanup = await Promise.allSettled([
    runtime.dispose(),
    tunnel?.close(),
    preview ? rm(preview, { force: true }) : undefined,
  ]);
  const errors = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failure) errors.unshift(failure);
  if (errors.length)
    throw new AggregateError(errors, "MCP smoke or cleanup failed.", {
      cause: errors[0],
    });
}
