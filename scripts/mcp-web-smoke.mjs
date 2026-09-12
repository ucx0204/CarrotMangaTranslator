const message =
  "Use the app: Settings > AI 연결 / MCP > 연결 진단.\n" +
  "Web connections now use Tailscale Funnel and app-side approval.\n" +
  "This retired password-file command does not read or send credentials.\n" +
  "See docs/mcp-tailscale-testing.md. No Codex quota is required.";

if (process.argv.includes("--help")) {
  console.log(message);
} else {
  console.error(message);
  process.exitCode = 1;
}
