const { execFile } = require("node:child_process");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const { join, relative, resolve } = require("node:path");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const root = resolve(__dirname, "..");

// Only the frame and synthetic state are fixtures. Controls, tabs, modal and CSS
// come from production components; the repository's QA runner supplies the bridge.
const fixture = `import React from "react";
import { createRoot } from "react-dom/client";
import type { McpDesktopStatus } from "../../shared/mcpDesktopTypes";
import { McpSettingsView } from "../src/components/settingsModal/McpSettingsPanel";
import { SettingsTabs } from "../src/components/settingsModal/SettingsTabs";
import { Modal } from "../src/components/ui/Modal";
import { ModalActionBar } from "../src/components/ui/ModalActionBar";
import { Button } from "../src/components/ui/Button";
import { AppI18nProvider } from "../src/i18n";
import { initializeAppI18n } from "../src/appI18n";
import "../src/styles.css";
const scenario = new URLSearchParams(location.search).get("scenario");
const status: McpDesktopStatus = {
  state: scenario === "error" ? "error" : "online", provider: "tailscale",
  url: "https://carrot-manga-translator-desktop-device.tail-user-network.ts.net/mcp",
  message: scenario === "error" ? "Tailscale HTTPS 443 포트는 다른 앱이 사용 중입니다. 기존 공유 설정을 덮어쓰지 않습니다." : null,
  setupUrl: null,
  preferences: { allowImages: true, allowEditing: true, autoStart: false },
  pairingUntil: Date.now() + 300000,
  pending: [{ id: "synthetic", clientName: "ChatGPT 개인 연결 · 확인 코드를 대조하세요", code: "739412", scope: "carrot.read carrot.images carrot.edit offline_access", expiresAt: Date.now() + 300000 }],
  connections: [{ id: "approved", clientName: "ChatGPT 이전 승인", scope: "carrot.read", createdAt: Date.now(), revoked: false }],
};
function audit() {
  const page = document.documentElement;
  const dialog = document.querySelector('[role="dialog"]');
  const panel = document.querySelector('[role="tabpanel"]');
  if (!dialog || !panel) throw new Error("MCP settings did not render");
  const rect = dialog.getBoundingClientRect();
  if (page.scrollWidth > innerWidth + 1 || page.scrollHeight > innerHeight + 1 ||
      rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1 ||
      panel.scrollWidth > panel.clientWidth + 1) throw new Error("MCP settings overflow the viewport");
  if (document.querySelector('input[type="password"]')) throw new Error("Unexpected pairing password control");
  if (scenario === "pairing") {
    const button = [...document.querySelectorAll("button")].find(item => item.textContent?.includes("같은 코드 확인"));
    if (!button) throw new Error("Missing app approval control");
    button.scrollIntoView({ block: "center" });
    const bounds = button.getBoundingClientRect();
    if (bounds.top < 0 || bounds.bottom > innerHeight) throw new Error("Approval control is unreachable");
  }
}
async function main() {
  await initializeAppI18n("ko");
  const target = document.getElementById("root");
  if (!target) throw new Error("Missing QA root");
  createRoot(target).render(<AppI18nProvider><Modal title="설정" width="min(920px, 100%)" fillHeight bodyClassName="settings-modal-body" onClose={() => {}}
    footer={<ModalActionBar actions={<><Button>취소</Button><Button variant="primary">저장</Button></>} />}>
    <div className="settings-layout"><SettingsTabs activeTab="mcp" onChange={() => {}} />
      <div className="settings-tabpanel modal-section" role="tabpanel" id="settings-panel-mcp" aria-labelledby="settings-tab-mcp">
        <header className="settings-panel-header"><h2>AI 연결 / MCP</h2></header>
        <McpSettingsView status={status} busy={false} error={null} diagnostics={null} run={async action => { await action(); }} diagnose={async () => {}} />
      </div></div></Modal></AppI18nProvider>);
  setTimeout(audit, 700);
}
void main();
`;

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: node scripts/mcp-ui-qa.cjs\nCaptures synthetic production MCP settings with the repository UI QA runner. No account, model or tunnel is used.",
    );
    return;
  }
  const renderer = join(root, "src/renderer");
  const directory = await mkdtemp(join(renderer, "mcp-qa-"));
  const output = join(root, ".tmp/mcp-ui-qa");
  try {
    await mkdir(output, { recursive: true });
    await writeFile(join(directory, "main.tsx"), fixture);
    await writeFile(
      join(directory, "index.html"),
      '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP QA</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
    );
    for (const [name, width, height, scenario] of [
      ["wide", 1600, 980, "online"],
      ["narrow", 1240, 760, "online"],
      ["pairing", 1240, 760, "pairing"],
      ["error", 1240, 760, "error"],
    ]) {
      const entry = `${relative(renderer, directory).replaceAll("\\", "/")}/index.html?scenario=${scenario}`;
      const result = await exec(
        process.execPath,
        [
          join(root, "scripts/ui-qa.mjs"),
          "--entry",
          entry,
          "--output",
          join(output, `${name}.png`),
          "--width",
          String(width),
          "--height",
          String(height),
          "--wait",
          "1800",
        ],
        { cwd: root, timeout: 90_000 },
      );
      console.log(result.stdout);
      console.log(
        `PASS production MCP settings ${name} capture and layout assertions`,
      );
    }
  } finally {
    // This newly created directory contains only our two temporary QA files.
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
