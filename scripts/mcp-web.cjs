const { randomBytes, randomUUID } = require("node:crypto");
const { mkdirSync, renameSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { startQuickTunnel } = require("./mcp-quick-tunnel.cjs");

const root = resolve(__dirname, "..");
/** @type {import("node:child_process").ChildProcess | undefined} */
let tunnel;
let appStarted = false;

/** @param {number} port */
async function assertPortFree(port) {
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error("MCP port is already in use. Close the previous test app first.")));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolvePromise(undefined)));
  });
}

/** Atomically replace only our generated connection files, never follow an existing file symlink.
 * @param {string} name @param {string} value */
function writeConnectionFile(name, value) {
  const temporary = join(root, ".tmp", `mcp-web-${randomUUID()}.tmp`);
  writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
  renameSync(temporary, join(root, ".tmp", name));
}

/** @param {string} origin */
async function waitForWebMetadata(origin) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (!tunnel || tunnel.exitCode !== null) throw new Error("Cloudflare tunnel stopped.");
    try {
      const response = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`, { redirect: "error", signal: AbortSignal.timeout(5000) });
      if (response.ok && (await response.json()).resource === `${origin}/mcp`) return;
    } catch (_error) {
      // Expected during app compilation, tunnel startup and DNS propagation; deadline is authoritative.
    }
    await delay(1000);
  }
  throw new Error("The public OAuth endpoint did not become ready. Check the app log and Cloudflare connectivity.");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node scripts/mcp-web.cjs [--images]\nStart an owned Cloudflare Quick Tunnel and the existing read-only app with OAuth.\nRequires installed cloudflared; no Codex account or API key is used.\nConnection password: .tmp/mcp-web-password (never send it in chat).\nOptional: CARROT_MCP_PORT, CARROT_CLOUDFLARED_PATH.");
    return;
  }
  if (args.some((arg) => arg !== "--images")) throw new Error("Unknown argument. Use --help.");
  const portText = process.env.CARROT_MCP_PORT ?? "38475";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw new Error("Invalid CARROT_MCP_PORT.");
  await assertPortFree(port);
  console.log("[mcp-web] Starting Cloudflare. Only the authenticated MCP listener is exposed; not the development UI.");
  const started = await startQuickTunnel(port);
  tunnel = started.child;
  tunnel.once("exit", () => {
    if (appStarted) {
      console.error("[mcp-web] Tunnel stopped; shutting down the development app.");
      process.emit("SIGTERM", "SIGTERM");
    }
  });
  mkdirSync(join(root, ".tmp"), { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString("base64url");
  writeConnectionFile("mcp-web-password", password);
  writeConnectionFile("mcp-web-connection.json", JSON.stringify({ url: `${started.origin}/mcp`, origin: started.origin, port, pid: process.pid }, null, 2));
  process.env.CARROT_MCP_PUBLIC_ORIGIN = started.origin;
  process.env.CARROT_MCP_OAUTH_ENABLED = "1";
  process.env.CARROT_MCP_OAUTH_PASSWORD = password;
  console.log(`[mcp-web] ChatGPT server URL: ${started.origin}/mcp`);
  console.log("[mcp-web] Authentication: OAuth / dynamic registration. Leave client ID and client secret empty.");
  console.log("[mcp-web] Password is in .tmp/mcp-web-password. Paste it only into the consent page on this exact tunnel host.");
  appStarted = true;
  // Share the established app build, locks, local token, image opt-in and child shutdown.
  require("./mcp-dev.cjs");
  await waitForWebMetadata(started.origin);
  console.log("[mcp-web] READY: public OAuth discovery responds. Run node scripts/mcp-web-smoke.mjs, then add the URL in ChatGPT Plugins.");
}

main().catch((error) => {
  console.error("[mcp-web] Failed:", error instanceof Error ? error.message : "Unknown failure");
  tunnel?.kill();
  process.exitCode = 1;
  if (appStarted) process.emit("SIGTERM", "SIGTERM");
});
