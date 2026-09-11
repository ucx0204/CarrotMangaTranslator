const { prepareLocalToken, tokenPath } = require("./mcp-test-connection.cjs");

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node scripts/mcp-dev.cjs [--images]\nStarts the existing development app with read-only MCP.\n--images explicitly allows source-page previews; app redaction rules still apply.\nToken is reused from .tmp/mcp-local-token and is never printed.\nOptional env: CARROT_MCP_PORT, CARROT_MCP_PUBLIC_ORIGIN, CARROT_MCP_TOKEN.");
    return;
  }
  if (args.some((arg) => arg !== "--images")) {
    throw new Error("Unknown argument. Use --help.");
  }
  process.env.CARROT_MCP_TOKEN = prepareLocalToken();
  process.env.CARROT_MCP_ENABLED = "1";
  process.env.CARROT_MCP_ALLOW_IMAGES = args.includes("--images") ? "1" : "0";
  console.log("[mcp] Starting the existing app; MCP is read-only.");
  console.log(`[mcp] Local token file: ${tokenPath} (secret; do not share or commit)`);
  console.log(`[mcp] Image transfer: ${args.includes("--images") ? "enabled; use only approved test images" : "disabled"}`);
  console.log("[mcp] After the app opens, run node scripts/mcp-smoke.mjs in another terminal.");
  // Reuse the established dev build, instance lock, renderer and child cleanup.
  require("./dev.cjs");
}

try {
  main();
} catch (error) {
  console.error("[mcp] Startup failed:", error instanceof Error ? error.message : "Unknown failure");
  process.exitCode = 1;
}
