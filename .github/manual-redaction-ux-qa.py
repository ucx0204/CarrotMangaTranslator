"""Capture the real continuous editor. No publishing, credentials or user files."""
import json
import os
import subprocess
from pathlib import Path

assert os.environ.get("GITHUB_REF") == "refs/heads/feat/manual-redaction-workspace-20260910"
ROOT = Path.cwd()
OUT = ROOT / ".tmp/manual-redaction-ux-qa"
OUT.mkdir(parents=True, exist_ok=True)

QA = r'''import React from "react";
import { createRoot } from "react-dom/client";
import { initializeAppI18n } from "./appI18n";
import { AppI18nProvider } from "./i18n";
import { ManualRedactionWorkspace } from "./components/imageRedaction/ManualRedactionWorkspace";
import { DEFAULT_REDACTION_VIEW, DEFAULT_REDACTION_PREFERENCES, type RedactionWorkspace } from "../../shared/imageRedactionWorkspace";
import "./styles.css";

async function waitFor(test: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("QA state did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
function button(label: string): HTMLButtonElement {
  const control = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
  if (!control) throw new Error(`Missing visible action: ${label}`);
  return control;
}
function inViewport(element: Element, label: string) {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1)
    throw new Error(`${label} is clipped or outside the viewport`);
}
async function start() {
  await initializeAppI18n("ko");
  const sample = await window.mangaApi.getPageImageDataUrl("manual-redaction-qa");
  let sends = 0;
  // Preserve the repository QA bridge and replace only this fixture's I/O.
  Object.assign(window.mangaApi, {
    getRedactionWorkspacePreview: async () => sample,
    saveRedactionWorkspace: async (request: { expectedRevision: number }) => request.expectedRevision + 1,
    closeRedactionWorkspace: async () => true,
    confirmImageRedaction: async () => { sends++; return true; },
  });
  const mode = new URLSearchParams(location.search).get("mode") ?? "edit";
  const workspace: RedactionWorkspace = {
    sessionId: "11111111-1111-4111-8111-111111111111", revision: 0,
    pages: Array.from({ length: 25 }, (_, index) => ({
      id: `p${index}`, name: `${String(index + 1).padStart(3, "0")}.png`,
      imagePath: `qa-page-${index}.png`, fingerprint: "a".repeat(64),
      width: 1200, height: 1600,
      decision: mode === "ready" ? "reviewed" : "unreviewed",
      strokes: index % 3 === 0 ? [{ shape: "rectangle", size: 40, points: [{ x: 680, y: 260 }, { x: 1000, y: 550 }] }] : [],
    })),
    view: { ...DEFAULT_REDACTION_VIEW, currentId: "p0", selectedIds: Array.from({ length: 25 }, (_, index) => `p${index}`) },
    preferences: { ...DEFAULT_REDACTION_PREFERENCES }, presets: [],
  };
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing QA root");
  createRoot(root).render(<React.StrictMode><AppI18nProvider>
    <ManualRedactionWorkspace workspace={workspace} job={{jobId:"22222222-2222-4222-8222-222222222222",sessionId:workspace.sessionId}} onClose={() => {}} />
  </AppI18nProvider></React.StrictMode>);
  await waitFor(() => {
    const image = document.querySelector<HTMLImageElement>('img[alt="001.png"]');
    return Boolean(image?.complete && image.naturalWidth > 0);
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  const pageControls = document.querySelector<HTMLElement>('[role="group"][aria-label="페이지 검토"]');
  if (!dialog || !pageControls) throw new Error("Missing production editor");
  inViewport(dialog, "dialog");
  inViewport(pageControls, "page review controls");
  inViewport(button("선택 25장 확인"), "visible selection review");
  inViewport(button("작업 재개"), "task resume");
  if (document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1)
    throw new Error("Unexpected document overflow");
  if (pageControls.contains(button("작업 재개"))) throw new Error("Page and task actions are mixed");
  if (button("작업 재개").disabled !== (mode !== "ready")) throw new Error("Incorrect approval gate");
  if (sends !== 0) throw new Error("Preview or autosave sent images");
  const allButtons = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"));
  if (allButtons.some((item) => /보류|확인 후 계속/.test(item.textContent ?? "")))
    throw new Error("Retired or ambiguous action remains");
  const status = Array.from(dialog.querySelectorAll<HTMLElement>('span')).find((item) => item.textContent === "저장됨");
  if (!status || status.closest("button") || status.querySelector("svg")) throw new Error("Save status looks actionable");
  if (mode === "menu") {
    button("선택 작업").click();
    await waitFor(() => Boolean(document.querySelector('[role="menu"]')));
    inViewport(document.querySelector('[role="menu"]')!, "selection menu");
  }
}
void start();
'''

html = ROOT / "src/renderer/manual-redaction-ux-qa.html"
entry = ROOT / "src/renderer/src/manual-redaction-ux-qa.tsx"
assert not html.exists() and not entry.exists(), "Refusing to overwrite existing files"
checks = []
try:
    html.write_text('<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/manual-redaction-ux-qa.tsx"></script></body></html>', encoding="utf-8")
    entry.write_text(QA, encoding="utf-8")
    for name, width, height, mode in [
        ("review-wide", 1600, 980, "edit"),
        ("review-narrow", 1240, 760, "edit"),
        ("review-small", 960, 620, "edit"),
        ("all-reviewed", 1240, 760, "ready"),
        ("selection-menu", 1240, 760, "menu"),
    ]:
        args = ["node", "scripts/ui-qa.mjs", "--entry", "manual-redaction-ux-qa.html?mode=" + mode, "--build-channel", "stable", "--width", str(width), "--height", str(height), "--wait", "6500", "--output", str(OUT / (name + ".png"))]
        try:
            result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=150)
            code, text = result.returncode, result.stdout + result.stderr
        except subprocess.TimeoutExpired:
            code, text = 124, "UI QA timed out"
        (OUT / (name + ".log")).write_text(text, encoding="utf-8")
        checks.append({"name": name, "width": width, "height": height, "exit_code": code})
        print(name + ": " + str(code), flush=True)
        print(text[-8000:], flush=True)
finally:
    html.unlink(missing_ok=True)
    entry.unlink(missing_ok=True)

report = {"source": os.environ.get("GITHUB_SHA"), "run_id": os.environ.get("GITHUB_RUN_ID"), "checks": checks}
(OUT / "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print("UI_QA=" + json.dumps(report), flush=True)
raise SystemExit(any(item["exit_code"] for item in checks))
