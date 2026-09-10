"""Capture real controls and preserve reproducible, tracked-source-only diagnostics."""
import hashlib
import json
import os
import subprocess
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

assert os.environ.get("GITHUB_REF") == "refs/heads/feat/manual-redaction-workspace-20260910"
ROOT = Path.cwd()
OUT = ROOT / ".tmp/manual-redaction-ux-qa"
OUT.mkdir(parents=True, exist_ok=True)

QA = r'''import React from "react";
import { createRoot } from "react-dom/client";
import { initializeAppI18n } from "./appI18n";
import { AppI18nProvider } from "./i18n";
import { APP_I18N_RESOURCES } from "../../shared/i18n/resources";
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
function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const control = Array.from(scope.querySelectorAll<HTMLButtonElement>("button"))
    .find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
  if (!control) throw new Error(`Missing visible action: ${label}`);
  return control;
}
function inViewport(element: Element, label: string) {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1)
    throw new Error(`${label} is clipped: ${JSON.stringify(rect.toJSON())}`);
}
function usable(control: HTMLButtonElement | HTMLInputElement) {
  const label = control.getAttribute("aria-label") || control.textContent?.trim() || control.tagName;
  inViewport(control, label);
  const rect = control.getBoundingClientRect();
  if (!control.disabled) {
    for (const ratio of [0.2, 0.5, 0.8]) {
      const hit = document.elementFromPoint(rect.left + rect.width * ratio, rect.top + rect.height / 2);
      if (!hit || !control.contains(hit)) throw new Error(`${label} is obscured by ${hit?.tagName}`);
    }
  }
}
function checkControls(scope: HTMLElement) {
  for (const input of scope.querySelectorAll<HTMLInputElement>('input[type="number"]')) {
    usable(input);
    const frame = input.closest('[data-ui-number-input-zone]')?.parentElement;
    if (!frame) throw new Error("Missing numeric frame");
    inViewport(frame, "numeric frame");
    const outer = frame.getBoundingClientRect(), inner = input.getBoundingClientRect();
    if (outer.width > 96 || inner.left < outer.left - 1 || inner.right > outer.right + 1)
      throw new Error(`Unbounded numeric field: ${JSON.stringify(outer.toJSON())}`);
  }
  for (const item of scope.querySelectorAll<HTMLButtonElement>('button')) {
    if (item.getAttribute("role") === "option" || item.closest('[role="listbox"]')) continue;
    if (item.getBoundingClientRect().width > 0) usable(item);
  }
}
async function start() {
  const params = new URLSearchParams(location.search);
  const locale = params.get("locale") === "en" ? "en" : params.get("locale") === "ja" ? "ja" : "ko";
  await initializeAppI18n(locale);
  const text = APP_I18N_RESOURCES[locale].components.manualRedaction;
  const mode = params.get("mode") ?? "edit";
  const count = mode === "many" ? 1000 : 25;
  const selectionLabel = text.reviewSelectedCount.replace("{{count}}", String(count));
  const sample = await window.mangaApi.getPageImageDataUrl("manual-redaction-qa");
  let sends = 0;
  Object.assign(window.mangaApi, {
    getRedactionWorkspacePreview: async () => sample,
    saveRedactionWorkspace: async (request: { expectedRevision: number }) => request.expectedRevision + 1,
    closeRedactionWorkspace: async () => true,
    confirmImageRedaction: async () => { sends++; return true; },
  });
  const workspace: RedactionWorkspace = {
    sessionId: "11111111-1111-4111-8111-111111111111", revision: 0,
    pages: Array.from({ length: count }, (_, index) => ({
      id: `p${index}`, name: `${String(index + 1).padStart(3, "0")}.png`,
      imagePath: `qa-page-${index}.png`, fingerprint: "a".repeat(64),
      width: 1200, height: 1600,
      decision: mode === "ready" ? "reviewed" : "unreviewed",
      strokes: index % 3 === 0 ? [{ shape: "rectangle", size: 40, points: [{ x: 680, y: 260 }, { x: 1000, y: 550 }] }] : [],
    })),
    view: { ...DEFAULT_REDACTION_VIEW, currentId: "p0", selectedIds: Array.from({ length: count }, (_, index) => `p${index}`) },
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
  const pageControls = document.querySelector<HTMLElement>(`[role="group"][aria-label="${text.pageReviewControls}"]`);
  if (!dialog || !pageControls) throw new Error("Missing production editor");
  inViewport(dialog, "dialog");
  inViewport(pageControls, "page review controls");
  usable(button(selectionLabel));
  usable(button(text.resumeTask));
  if (pageControls.contains(button(text.resumeTask))) throw new Error("Page and task actions are mixed");
  if (button(text.resumeTask).disabled !== (mode !== "ready")) throw new Error("Incorrect approval gate");
  if (mode === "brush") button(text.tool_brush).click();
  if (mode === "reviewed") button(text.reviewPage).click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  checkControls(dialog);
  if (document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1)
    throw new Error("Unexpected document overflow");
  const allButtons = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"));
  if (allButtons.some((item) => /보류|확인 후 계속/.test(item.textContent ?? "")))
    throw new Error("Retired or ambiguous action remains");
  const status = Array.from(dialog.querySelectorAll<HTMLElement>('span')).find((item) => item.textContent === text.save_saved);
  if (!status || status.closest("button") || status.querySelector("svg")) throw new Error("Save status looks actionable");
  if (mode === "menu") {
    button(text.selectionMenu).click();
    await waitFor(() => Boolean(document.querySelector('[role="menu"]')));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    inViewport(menu, "selection menu");
    checkControls(menu);
  }
  if (mode === "bulk") {
    button(selectionLabel).click();
    await waitFor(() => document.querySelectorAll('[role="dialog"]').length === 2);
    const batch = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).at(-1)!;
    inViewport(batch, "batch review");
    if (batch.querySelector('input[type="checkbox"], [role="checkbox"]')) throw new Error("Redundant review checkbox remains");
    if (button(selectionLabel, batch).disabled) throw new Error("Unloaded previews block explicit review");
    checkControls(batch);
  }
  if (sends !== 0) throw new Error("Preview, autosave or page review sent images");
  document.body.dataset.redactionQa = "passed";
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
    for name, width, height, mode, locale in [
        ("review-wide", 1600, 980, "edit", "ko"),
        ("review-narrow", 1240, 760, "edit", "ko"),
        ("review-small", 960, 620, "edit", "ko"),
        ("page-reviewed", 1240, 760, "reviewed", "ko"),
        ("all-reviewed", 1240, 760, "ready", "ko"),
        ("selection-menu", 1240, 760, "menu", "ko"),
        ("brush-small", 960, 620, "brush", "ko"),
        ("bulk-review", 960, 620, "bulk", "ko"),
        ("many-pages", 1240, 760, "many", "ko"),
        ("english-small", 960, 620, "edit", "en"),
        ("japanese-small", 960, 620, "edit", "ja"),
    ]:
        target = f"manual-redaction-ux-qa.html?mode={mode}&locale={locale}"
        args = ["node", "scripts/ui-qa.mjs", "--entry", target, "--build-channel", "stable", "--width", str(width), "--height", str(height), "--wait", "6500", "--output", str(OUT / (name + ".png"))]
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

# Only committed, allowlisted source and UI assets: never copy a working data directory.
tracked = subprocess.check_output(["git", "ls-files", "-z"]).decode("utf-8").split("\0")
text_types = {".ts", ".tsx", ".css", ".json", ".md", ".yml", ".yaml", ".js", ".cjs", ".mjs", ".py", ".html", ".txt", ".svg", ".rs", ".toml", ".lock"}
root_names = {"AGENTS.md", ".gitignore", ".prettierignore", ".editorconfig", ".gitattributes", ".jscpd.json"}
assets = {"src/renderer/src/assets/completion.ogg", "src/renderer/src/assets/inpainting-guide.png", "src/renderer/src/assets/sfx-script-icon.png"}
manifest = []
with ZipFile(OUT / "source-checkpoint.zip", "w", ZIP_DEFLATED) as archive:
    for name in sorted(filter(None, tracked)):
        path = ROOT / name
        allowed_root = "/" not in name and (path.suffix in text_types or name in root_names)
        allowed_source = name.startswith(("src/", "tests/", "scripts/", "docs/", ".github/", "tools/", "third_party/")) and path.suffix in text_types
        if not (allowed_root or allowed_source or name in assets) or path.is_symlink() or not path.is_file():
            continue
        data = path.read_bytes()
        if name not in assets:
            try:
                data.decode("utf-8")
            except UnicodeDecodeError:
                continue
        archive.writestr(name, data)
        manifest.append({"path": name, "sha256": hashlib.sha256(data).hexdigest()})
    archive.writestr("source-manifest.json", json.dumps({"source": os.environ.get("GITHUB_SHA"), "files": manifest}, indent=2))
report = {"source": os.environ.get("GITHUB_SHA"), "run_id": os.environ.get("GITHUB_RUN_ID"), "checks": checks}
(OUT / "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print("UI_QA=" + json.dumps(report), flush=True)
raise SystemExit(any(item["exit_code"] for item in checks))
