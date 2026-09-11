import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import probeModule from "./mcp-web-probe.cjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: node scripts/mcp-web-smoke.mjs\nRun after mcp-web.cjs reports READY. Tests public discovery, consent, PKCE, token refresh, MCP reads and revocation.\nReads .tmp/mcp-web-connection.json and .tmp/mcp-web-password. No model account or API key is used.\nNever follows the ChatGPT callback or prints passwords/tokens. It does not test the ChatGPT UI itself.");
    return;
  }
  if (process.argv.length !== 2) throw new Error("Unknown argument. Use --help.");
  const connection = JSON.parse(await readFile(join(root, ".tmp/mcp-web-connection.json"), "utf8"));
  const url = new URL(connection.url);
  if (url.protocol !== "https:" || url.pathname !== "/mcp" || url.username || url.password || url.search || url.hash)
    throw new Error("Invalid saved web endpoint. Restart mcp-web.cjs.");
  const password = (await readFile(join(root, ".tmp/mcp-web-password"), "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(password)) throw new Error("Invalid connection password file.");
  await probeModule.runMcpWebProbe(url.href, password);
}

main().catch(() => {
  // Do not dump HTTP bodies, authorization URLs or tokens into terminal logs.
  console.error("FAIL web OAuth diagnostic. Confirm mcp-web.cjs is READY and these files belong to that running instance. See docs/mcp-web-testing.md and the last PASS stage. Do not share the password or token files.");
  process.exitCode = 1;
});
