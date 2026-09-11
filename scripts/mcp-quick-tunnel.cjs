const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

/** @param {string} text @returns {string | null} */
function findQuickTunnelOrigin(text) {
  const match = text.match(
    /https:\/\/[a-z0-9][a-z0-9-]{0,120}\.trycloudflare\.com(?=[\s|]|$)/,
  );
  return match ? match[0] : null;
}

/** @param {number} port @param {string} [binary]
 * @returns {Promise<{origin: string, child: import("node:child_process").ChildProcess}>} */
function startQuickTunnel(
  port,
  binary = process.env.CARROT_CLOUDFLARED_PATH || "cloudflared",
) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return Promise.reject(new Error("Invalid MCP port."));
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let buffer = "";
    let ready = false;
    const cleanupOnExit = () => {
      child.kill();
    };
    const stopDuringStartup = () => {
      if (!ready) child.kill();
    };
    process.once("exit", cleanupOnExit);
    process.on("SIGINT", stopDuringStartup);
    process.on("SIGTERM", stopDuringStartup);
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          "Cloudflare did not provide a Quick Tunnel URL. Check connectivity and local cloudflared configuration.",
        ),
      );
    }, 45_000);
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      if (ready) return;
      buffer = (buffer + chunk.toString("utf8")).slice(-8192);
      const origin = findQuickTunnelOrigin(buffer);
      if (!origin) return;
      ready = true;
      clearTimeout(timer);
      resolve({ origin, child });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", () => {
      clearTimeout(timer);
      reject(
        new Error(
          "Could not start cloudflared. Install it or set CARROT_CLOUDFLARED_PATH to the executable.",
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      process.off("exit", cleanupOnExit);
      process.off("SIGINT", stopDuringStartup);
      process.off("SIGTERM", stopDuringStartup);
      if (!ready)
        reject(
          new Error(
            `Cloudflare exited before connection (code ${code}). Check cloudflared configuration and network access.`,
          ),
        );
    });
  });
}

/** Verify the exact public resource before any connection credentials are used.
 * @param {string} origin @param {import("node:child_process").ChildProcess} child */
async function waitQuickTunnelReady(origin, child) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Cloudflare tunnel stopped.");
    try {
      const response = await fetch(
        `${origin}/.well-known/oauth-protected-resource/mcp`,
        { redirect: "error", signal: AbortSignal.timeout(5000) },
      );
      if (response.ok && (await response.json()).resource === `${origin}/mcp`)
        return;
    } catch (_error) {
      // error-policy-allow: DNS propagation and app startup are retried only until the fixed deadline.
    }
    await delay(1000);
  }
  throw new Error(
    "The public OAuth endpoint did not become ready. Check the app log and Cloudflare connectivity.",
  );
}

module.exports = {
  findQuickTunnelOrigin,
  startQuickTunnel,
  waitQuickTunnelReady,
};
