const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: node scripts/mcp-web.cjs\nStarts the existing app. Configure Tailscale Funnel in Settings > AI connection / MCP. No Cloudflare or password file is used. Image permission is managed in the app.",
  );
} else if (args.length) {
  console.error(
    "Use the app settings for image permission; this launcher takes no options.",
  );
  process.exitCode = 1;
} else {
  for (const name of [
    "CARROT_MCP_ENABLED",
    "CARROT_MCP_OAUTH_ENABLED",
    "CARROT_MCP_PUBLIC_ORIGIN",
    "CARROT_MCP_TOKEN",
    "CARROT_MCP_OAUTH_PASSWORD",
  ])
    delete process.env[name];
  require("./dev.cjs");
}
