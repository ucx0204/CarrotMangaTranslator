const { randomBytes, randomUUID } = require("node:crypto");
const { mkdirSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join, resolve } = require("node:path");
const { startQuickTunnel, waitQuickTunnelReady } = require("./mcp-quick-tunnel.cjs");

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
  try {
    renameSync(temporary, join(root, ".tmp", name));
  } catch (error) {
    try { rmSync(temporary, { force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Connection file setup and cleanup failed."); }
    throw error;
  }
}

/** @param {string} origin @param {number} port */
function configureWebConnection(origin, port) {
  mkdirSync(join(root, ".tmp"), { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString("base64url");
  writeConnectionFile("mcp-web-password", password);
  writeConnectionFile("mcp-web-connection.json", JSON.stringify({ url: `${origin}/mcp`, origin, port, pid: process.pid }, null, 2));
  process.env.CARROT_MCP_PUBLIC_ORIGIN = origin;
  process.env.CARROT_MCP_OAUTH_ENABLED = "1";
  process.env.CARROT_MCP_OAUTH_PASSWORD = password;
  console.log(`[mcp-web] ChatGPT server URL: ${origin}/mcp`);
  console.log("[mcp-web] Authentication: OAuth / dynamic registration. Leave client ID and client secret empty.");
  console.log("[mcp-web] Password is in .tmp/mcp-web-password. Paste it only into the consent page on this exact tunnel host.");
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
  configureWebConnection(started.origin, port);
  appStarted = true;
  // Share the established app build, locks, local token, image opt-in and child shutdown.
  require("./mcp-dev.cjs");
  await waitQuickTunnelReady(started.origin, started.child);
  console.log("[mcp-web] READY: public OAuth discovery responds. Run node scripts/mcp-web-smoke.mjs, then add the URL in ChatGPT Plugins.");
}

main().catch((error) => {
  console.error("[mcp-web] Failed:", error instanceof Error ? error.message : "Unknown failure");
  tunnel?.kill();
  process.exitCode = 1;
  if (appStarted) process.emit("SIGTERM", "SIGTERM");
});
