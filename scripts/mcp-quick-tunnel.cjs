const { spawn } = require("node:child_process");

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
    child.once("exit", (code) => {
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

module.exports = { findQuickTunnelOrigin, startQuickTunnel };
